"""Prediction backends: ONNX student (contract model dir) and the rules-v1 fallback."""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from . import contract as C
from . import rules, textin

RULES_HEADS = {
    "tier": ["haiku", "sonnet", "opus"],
    "effort": ["low", "medium", "high"],
    "plan_first": ["no", "yes"],
    "delegate_explore": ["no", "yes"],
}


@dataclass
class Prediction:
    heads: dict[str, list[str]]
    probs: dict[str, list[float]]  # calibrated probabilities per head
    n_tokens: int
    abstain_at: dict[str, float] = field(default_factory=dict)  # head -> min confidence (route abstention)
    yes_at: dict[str, float] = field(default_factory=dict)
    reasons: list[str] | None = None
    route_confidence: float | None = None  # overrides tier confidence when set (rules)
    forced_abstain: bool | None = None

    def top(self, head: str) -> tuple[int, float]:
        p = self.probs[head]
        i = max(range(len(p)), key=p.__getitem__)
        return i, p[i]


class Backend(Protocol):
    run_id: str
    kind: str
    loaded_at: float
    heads: dict[str, list[str]]

    def predict(self, text: str | list[str], context: dict[str, Any]) -> Prediction: ...


def softmax(logits: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    z = logits.astype(np.float64) / temperature
    z -= z.max()
    e = np.exp(z)
    return e / e.sum()


class OnnxBackend:
    kind = "onnx"

    def __init__(self, model_dir: str | Path, *, threads: int | None = None, warmup: bool = True) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.contract = C.validate_files(model_dir)
        c = self.contract
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads if threads else min(4, os.cpu_count() or 1)
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        try:
            self._sess = ort.InferenceSession(str(c.model_path), so, providers=["CPUExecutionProvider"])
        except Exception as e:  # corrupt graph, unsupported op, ...
            raise C.ContractError([f"model.onnx: cannot load ({e})"], c.model_dir) from e
        C.validate_session_io(c, self._sess.get_inputs(), self._sess.get_outputs())
        try:
            self._tok = Tokenizer.from_file(str(c.tokenizer_path))
        except Exception as e:
            raise C.ContractError([f"tokenizer.json: cannot load ({e})"], c.model_dir) from e
        self._tok.no_padding()
        self._tok.no_truncation()
        self._in_names = {i.name for i in self._sess.get_inputs()}
        self._out_names = [C.OUTPUT_PREFIX + h for h in c.heads]
        self._run_lock = threading.Lock()  # one ORT session, serialized: no thread oversubscription
        self.run_id = c.run_id
        self.heads = c.heads
        self.loaded_at = time.time()
        if warmup:
            self.warmup()

    # -- tokenization -------------------------------------------------------------------------------------------
    def encode(self, text: str | list[str], context: dict[str, Any]) -> list[int]:
        c = self.contract
        s = textin.render(c.input_template, text, context)
        ids = self._tok.encode(s).ids
        return textin.head_tail(ids, c.max_len, c.head_frac)

    # -- inference ----------------------------------------------------------------------------------------------
    def _run(self, ids: list[int]) -> list[np.ndarray]:
        arr = np.asarray([ids], dtype=np.int64)
        feed: dict[str, np.ndarray] = {"input_ids": arr, "attention_mask": np.ones_like(arr)}
        if "token_type_ids" in self._in_names:
            feed["token_type_ids"] = np.zeros_like(arr)
        with self._run_lock:
            return self._sess.run(self._out_names, feed)

    def predict(self, text: str | list[str], context: dict[str, Any]) -> Prediction:
        c = self.contract
        ids = self.encode(text, context)
        if not ids:
            ids = [0]
        outs = self._run(ids)
        probs = {h: softmax(o[0], c.temperatures.get(h, 1.0)).tolist() for h, o in zip(c.heads, outs)}
        return Prediction(heads=c.heads, probs=probs, n_tokens=len(ids), abstain_at=c.abstain, yes_at=c.yes_threshold)

    def warmup(self) -> None:
        c = self.contract
        for n in (16, 16, c.max_len):
            self._run([1] * n)


class RulesBackend:
    """rules-v1: Python port of plugin/core/task.ts classifyRules, shaped as head distributions."""

    kind = "rules"
    run_id = rules.RULES_RUN_ID

    def __init__(self) -> None:
        self.loaded_at = time.time()
        self.heads = RULES_HEADS

    def predict(self, text: str | list[str], context: dict[str, Any]) -> Prediction:
        prompt = text[0] if isinstance(text, list) and text else textin.join_text(text)
        ctx = context or {}
        ct = ctx.get("context_tokens", ctx.get("ctx", ctx.get("contextTokens", 0)))
        start = ctx.get("is_session_start", ctx.get("isSessionStart"))
        if start is None:
            start = ctx.get("start") in ("session", "first-prompt", "clear", "compact", "cold", "idle")
        feats = rules.extract_features(
            prompt, context_tokens=int(ct) if isinstance(ct, (int, float)) and not isinstance(ct, bool) else 0, is_session_start=bool(start)
        )
        v = rules.classify_rules(feats)

        def spread(labels: list[str], chosen: str, conf: float) -> list[float]:
            rest = (1.0 - conf) / (len(labels) - 1)
            return [conf if lab == chosen else rest for lab in labels]

        # plan_first: the rules sent it to opus (heavy/planning keywords); delegate_explore: rules cannot tell -> 0.5
        plan_first = v.tier == "opus"
        probs = {
            "tier": spread(RULES_HEADS["tier"], v.tier, v.confidence),
            "effort": spread(RULES_HEADS["effort"], v.effort, v.confidence),
            "plan_first": [1 - v.confidence, v.confidence] if plan_first else [v.confidence, 1 - v.confidence],
            "delegate_explore": [0.5, 0.5],
        }
        return Prediction(
            heads=RULES_HEADS, probs=probs, n_tokens=0, reasons=v.reasons, route_confidence=v.confidence, forced_abstain=False
        )
