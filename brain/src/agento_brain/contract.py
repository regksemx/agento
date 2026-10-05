"""Model-dir artifact contract (see brain/CONTRACT.md). Validation collects every problem, then raises once."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REQUIRED_FILES = ("model.onnx", "tokenizer.json", "heads.json", "meta.json")
REQUIRED_HEADS = ("tier", "effort", "plan_first", "delegate_explore")
BINARY_LABELS = ["no", "yes"]
TIERS = {"haiku", "sonnet", "opus", "fable"}
EFFORTS = {"low", "medium", "high", "xhigh"}
OUTPUT_PREFIX = "logits_"
KNOWN_INPUTS = {"input_ids", "attention_mask", "token_type_ids"}
CONTRACT_VERSION = 1


class ContractError(Exception):
    def __init__(self, problems: list[str], model_dir: Path | None = None) -> None:
        self.problems = problems
        self.model_dir = model_dir
        where = f" in {model_dir}" if model_dir else ""
        super().__init__(f"model contract violated{where}:\n  - " + "\n  - ".join(problems))


@dataclass
class Contract:
    model_dir: Path
    heads: dict[str, list[str]]
    max_len: int
    temperatures: dict[str, float]
    abstain: dict[str, float]  # head -> min confidence
    yes_threshold: dict[str, float]  # binary head -> P(yes) cutoff
    input_template: str
    head_frac: float
    meta: dict[str, Any]
    run_id: str
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def model_path(self) -> Path:
        return self.model_dir / "model.onnx"

    @property
    def tokenizer_path(self) -> Path:
        return self.model_dir / "tokenizer.json"

    def is_binary(self, head: str) -> bool:
        return self.heads[head] == BINARY_LABELS


def _load_json(path: Path, problems: list[str]) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None  # reported by the missing-file check
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
        problems.append(f"{path.name}: unreadable JSON ({e})")
        return None


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _validate_heads(raw: Any, problems: list[str]) -> dict[str, list[str]]:
    heads: dict[str, list[str]] = {}
    if not isinstance(raw, dict) or not raw:
        problems.append("heads.json: `heads` must be a non-empty object {head: [labels]}")
        return heads
    for name in REQUIRED_HEADS:
        if name not in raw:
            problems.append(f"heads.json: required head `{name}` is missing")
    for name, labels in raw.items():
        if not isinstance(labels, list) or len(labels) < 2 or not all(isinstance(x, str) and x for x in labels):
            problems.append(f"heads.json: head `{name}` must be a list of >= 2 non-empty strings")
            continue
        if len(set(labels)) != len(labels):
            problems.append(f"heads.json: head `{name}` has duplicate labels")
            continue
        if name == "tier" and not set(labels) <= TIERS:
            problems.append(f"heads.json: head `tier` labels {labels} must be a subset of {sorted(TIERS)}")
        if name == "effort" and not set(labels) <= EFFORTS:
            problems.append(f"heads.json: head `effort` labels {labels} must be a subset of {sorted(EFFORTS)}")
        if name in ("plan_first", "delegate_explore") and labels != BINARY_LABELS:
            problems.append(f"heads.json: head `{name}` labels must be exactly {BINARY_LABELS} (index 1 = yes)")
        heads[name] = labels
    # tier / effort order must be ascending (the ordinal meaning of `score` answers depends on it)
    order_t = ["haiku", "sonnet", "opus", "fable"]
    order_e = ["low", "medium", "high", "xhigh"]
    for name, order in (("tier", order_t), ("effort", order_e)):
        lab = heads.get(name)
        if lab and set(lab) <= set(order) and lab != [x for x in order if x in lab]:
            problems.append(f"heads.json: head `{name}` labels must be in ascending order, got {lab}")
    return heads


def _validate_per_head(raw: Any, field_name: str, heads: dict[str, list[str]], problems: list[str], *, lo: float, hi: float, strict_lo: bool) -> dict[str, float]:
    out: dict[str, float] = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        problems.append(f"heads.json: `{field_name}` must be an object {{head: number}}")
        return out
    for k, v in raw.items():
        if k not in heads:
            problems.append(f"heads.json: `{field_name}` references unknown head `{k}`")
        elif not _is_num(v) or not ((v > lo) if strict_lo else (v >= lo)) or v > hi:
            problems.append(f"heads.json: `{field_name}.{k}` must be a number in {'(' if strict_lo else '['}{lo}, {hi}], got {v!r}")
        else:
            out[k] = float(v)
    return out


def validate_files(model_dir: str | Path) -> Contract:
    """Everything that can be checked without loading the ONNX graph."""
    model_dir = Path(model_dir)
    problems: list[str] = []
    if not model_dir.is_dir():
        raise ContractError([f"not a directory: {model_dir}"], model_dir)
    for f in REQUIRED_FILES:
        p = model_dir / f
        if not p.is_file():
            problems.append(f"missing required file `{f}`")
        elif p.stat().st_size == 0:
            problems.append(f"required file `{f}` is empty")

    hj = _load_json(model_dir / "heads.json", problems)
    meta = _load_json(model_dir / "meta.json", problems)
    _load_json(model_dir / "tokenizer.json", problems)

    heads: dict[str, list[str]] = {}
    max_len = 0
    temps: dict[str, float] = {}
    abstain: dict[str, float] = {}
    yes_thr: dict[str, float] = {}
    template = ""
    head_frac = 0.75
    extra: dict[str, Any] = {}

    if hj is not None:
        if not isinstance(hj, dict):
            problems.append("heads.json: top level must be an object")
        else:
            heads = _validate_heads(hj.get("heads"), problems)
            ml = hj.get("max_len")
            if not isinstance(ml, int) or isinstance(ml, bool) or not 8 <= ml <= 8192:
                problems.append(f"heads.json: `max_len` must be an integer in [8, 8192], got {ml!r}")
            else:
                max_len = ml
            temps = _validate_per_head(hj.get("temperatures"), "temperatures", heads, problems, lo=0.0, hi=100.0, strict_lo=True)
            thr = hj.get("thresholds", {})
            if not isinstance(thr, dict):
                problems.append("heads.json: `thresholds` must be an object {abstain: {...}, yes: {...}}")
            else:
                for k in thr:
                    if k not in ("abstain", "yes"):
                        problems.append(f"heads.json: `thresholds.{k}` is not a known key (allowed: abstain, yes)")
                abstain = _validate_per_head(thr.get("abstain"), "thresholds.abstain", heads, problems, lo=0.0, hi=1.0, strict_lo=False)
                yes_thr = _validate_per_head(thr.get("yes"), "thresholds.yes", heads, problems, lo=0.0, hi=1.0, strict_lo=False)
                for k in yes_thr:
                    if k in heads and heads[k] != BINARY_LABELS:
                        problems.append(f"heads.json: `thresholds.yes.{k}` only applies to binary heads")
            template = hj.get("input_template")
            if not isinstance(template, str) or "{text}" not in template:
                problems.append("heads.json: `input_template` must be a string containing the `{text}` placeholder")
                template = ""
            hf = hj.get("head_frac", 0.75)
            if not _is_num(hf) or not 0 < hf < 1:
                problems.append("heads.json: optional `head_frac` must be a number in (0, 1)")
            else:
                head_frac = float(hf)
            extra = {k: v for k, v in hj.items() if k not in ("heads", "max_len", "temperatures", "thresholds", "input_template", "head_frac")}

    run_id = ""
    if meta is not None:
        if not isinstance(meta, dict):
            problems.append("meta.json: top level must be an object")
        else:
            rid = meta.get("run_id")
            if not isinstance(rid, str) or not rid.strip():
                problems.append("meta.json: `run_id` must be a non-empty string")
            else:
                run_id = rid
            if "metrics" in meta and not isinstance(meta["metrics"], dict):
                problems.append("meta.json: `metrics` must be an object")
            sha = meta.get("model_sha256")
            mp = model_dir / "model.onnx"
            if sha is not None and mp.is_file():
                if not isinstance(sha, str):
                    problems.append("meta.json: `model_sha256` must be a hex string")
                else:
                    h = hashlib.sha256()
                    with mp.open("rb") as fh:
                        for chunk in iter(lambda: fh.read(1 << 20), b""):
                            h.update(chunk)
                    if h.hexdigest() != sha.lower():
                        problems.append("meta.json: `model_sha256` does not match model.onnx")

    if problems:
        raise ContractError(problems, model_dir)
    return Contract(
        model_dir=model_dir, heads=heads, max_len=max_len, temperatures=temps, abstain=abstain, yes_threshold=yes_thr,
        input_template=template, head_frac=head_frac, meta=meta, run_id=run_id, extra=extra,
    )


def validate_session_io(contract: Contract, inputs: list[Any], outputs: list[Any]) -> None:
    """Check the ONNX graph interface against heads.json. `inputs`/`outputs` are ORT NodeArg lists."""
    problems: list[str] = []
    in_names = {i.name for i in inputs}
    for need in ("input_ids", "attention_mask"):
        if need not in in_names:
            problems.append(f"model.onnx: missing required input `{need}` (has {sorted(in_names)})")
    unknown = in_names - KNOWN_INPUTS
    if unknown:
        problems.append(f"model.onnx: unsupported extra inputs {sorted(unknown)} (allowed: {sorted(KNOWN_INPUTS)})")
    by_name = {o.name: o for o in outputs}
    for head, labels in contract.heads.items():
        o = by_name.get(OUTPUT_PREFIX + head)
        if o is None:
            problems.append(f"model.onnx: missing output `{OUTPUT_PREFIX}{head}` (has {sorted(by_name)})")
            continue
        shape = list(o.shape or [])
        if len(shape) != 2:
            problems.append(f"model.onnx: output `{o.name}` must be rank 2 [batch, {len(labels)}], got {shape}")
        elif isinstance(shape[1], int) and shape[1] != len(labels):
            problems.append(f"model.onnx: output `{o.name}` has {shape[1]} classes, heads.json lists {len(labels)} labels")
    if problems:
        raise ContractError(problems, contract.model_dir)
