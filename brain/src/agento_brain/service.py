"""HTTP-independent request handling: /v1/systemone, /v1/route, /healthz. Each returns (status, json-able dict)."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from . import __version__
from .backends import Backend, Prediction
from .stats import LatencyStats

QUESTION_TYPES = ("choice", "score", "noul")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message

    def body(self) -> dict:
        return {"error": {"code": self.code, "message": self.message}}


def _r(x: float) -> float:
    return round(float(x), 6)


def _min_conf(v: Any, where: str) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.0 <= v <= 1.0:
        raise ApiError(400, "bad_request", f"{where}: min_confidence must be a number in [0, 1]")
    return float(v)


def _text_and_context(text: Any, context: Any, where: str) -> tuple[str | list[str], dict]:
    if isinstance(text, str):
        pass
    elif isinstance(text, list) and all(isinstance(t, str) for t in text) and text:
        pass
    else:
        raise ApiError(400, "bad_request", f"{where}: `text` is required (string, or non-empty list of strings)")
    if context is None:
        context = {}
    if not isinstance(context, dict):
        raise ApiError(400, "bad_request", f"{where}: `context` must be an object")
    return text, context


class Service:
    def __init__(self, backend: Backend, stats: LatencyStats | None = None) -> None:
        self.backend = backend
        self.stats = stats or LatencyStats()

    # ------------------------------------------------------------------ /healthz
    def healthz(self) -> tuple[int, dict]:
        snap = self.stats.snapshot()
        return 200, {
            "ok": True,
            "model_run_id": self.backend.run_id,
            "backend": self.backend.kind,
            "loaded_at": datetime.fromtimestamp(self.backend.loaded_at, timezone.utc).isoformat(timespec="seconds"),
            "p50_ms": snap["p50_ms"],
            "p95_ms": snap["p95_ms"],
            "requests": snap["count"],
            "version": __version__,
        }

    # ------------------------------------------------------------------ /v1/route
    def route(self, body: Any) -> tuple[int, dict]:
        if not isinstance(body, dict):
            raise ApiError(400, "bad_request", "body must be a JSON object")
        text, ctx = _text_and_context(body.get("text"), body.get("context"), "route")
        t0 = time.perf_counter()
        pred = self.backend.predict(text, ctx)
        out = self._route_body(pred)
        ms = (time.perf_counter() - t0) * 1000
        self.stats.record(ms)
        out["latency_ms"] = round(ms, 3)
        out["model_run_id"] = self.backend.run_id
        return 200, out

    def _route_body(self, p: Prediction) -> dict:
        ti, tconf = p.top("tier")
        ei, econf = p.top("effort")
        out: dict[str, Any] = {
            "tier": p.heads["tier"][ti],
            "effort": p.heads["effort"][ei],
            "plan_first": p.probs["plan_first"][1] > p.yes_at.get("plan_first", 0.5),
            "delegate_explore": p.probs["delegate_explore"][1] > p.yes_at.get("delegate_explore", 0.5),
            "confidence": _r(p.route_confidence if p.route_confidence is not None else tconf),
        }
        if p.forced_abstain is not None:
            out["abstain"] = p.forced_abstain
        else:
            out["abstain"] = tconf < p.abstain_at.get("tier", 0.0) or econf < p.abstain_at.get("effort", 0.0)
        if p.reasons is not None:
            out["reasons"] = p.reasons
        return out

    # ------------------------------------------------------------------ /v1/systemone
    def systemone(self, body: Any) -> tuple[int, dict]:
        if not isinstance(body, dict):
            raise ApiError(400, "bad_request", "body must be a JSON object")
        state = body.get("state")
        if not isinstance(state, dict):
            raise ApiError(400, "bad_request", "`state` must be an object with `text` (and optional `context`)")
        text = state.get("text", state.get("prompt"))
        if "context" in state:
            context = state["context"]
        else:  # flat state: every key except the prompt is a header field
            context = {k: v for k, v in state.items() if k not in ("text", "prompt")}
        text, context = _text_and_context(text, context, "state")
        questions = body.get("questions")
        if not isinstance(questions, dict) or not questions:
            raise ApiError(400, "bad_request", "`questions` must be a non-empty object {name: {type, ...}}")
        default_min = _min_conf(body.get("min_confidence"), "request")

        heads = self.backend.heads
        plan = [self._plan_question(name, spec, heads, default_min) for name, spec in questions.items()]

        t0 = time.perf_counter()
        pred = self.backend.predict(text, context)
        answers = {name: fn(pred) for name, fn in plan}
        ms = (time.perf_counter() - t0) * 1000
        self.stats.record(ms)
        return 200, {
            "answers": answers,
            "usage": {"input_tokens": pred.n_tokens, "output_tokens": 0},
            "model_run_id": self.backend.run_id,
            "latency_ms": round(ms, 3),
        }

    def _plan_question(self, name: str, spec: Any, heads: dict[str, list[str]], default_min: float | None):
        """Validate one question up front (so errors are 400s before any inference) and return its answer function."""
        if not isinstance(spec, dict):
            raise ApiError(400, "bad_request", f"question {name!r}: spec must be an object")
        qtype = spec.get("type")
        if qtype not in QUESTION_TYPES:
            raise ApiError(400, "unknown_question_type", f"question {name!r}: type must be one of {list(QUESTION_TYPES)}, got {qtype!r}")
        head = spec.get("head", name)
        if not isinstance(head, str) or head not in heads:
            raise ApiError(400, "unknown_question", f"unknown question {name!r}; supported: {sorted(heads)}")
        labels = heads[head]
        min_conf = _min_conf(spec.get("min_confidence"), f"question {name!r}")
        if min_conf is None:
            min_conf = default_min

        if qtype == "noul":
            if labels != ["no", "yes"]:
                raise ApiError(400, "bad_question", f"question {name!r}: `noul` needs a binary head, but {head!r} has labels {labels}")
            return name, lambda p: _answer_noul(p.probs[head], min_conf)

        subset = spec.get("options" if qtype == "choice" else "levels", spec.get("labels"))
        idx = list(range(len(labels)))
        if subset is not None:
            if not isinstance(subset, list) or len(subset) < 2 or not all(isinstance(x, str) for x in subset):
                raise ApiError(400, "bad_question", f"question {name!r}: options/levels must be a list of >= 2 labels")
            bad = [x for x in subset if x not in labels]
            if bad or len(set(subset)) != len(subset):
                raise ApiError(400, "bad_question", f"question {name!r}: options {bad or subset} not valid for head {head!r} (labels: {labels})")
            idx = [labels.index(x) for x in subset]
        sel = [labels[i] for i in idx]
        if qtype == "choice":
            return name, lambda p: _answer_choice(sel, [p.probs[head][i] for i in idx], min_conf)
        return name, lambda p: _answer_score(sel, [p.probs[head][i] for i in idx], min_conf)


def _renorm(ps: list[float]) -> list[float]:
    s = sum(ps)
    return [x / s for x in ps] if s > 0 else [1 / len(ps)] * len(ps)


def _abstention(conf: float, min_conf: float | None) -> dict:
    return {"abstained": min_conf is not None and conf < min_conf, "min_confidence": min_conf}


def _answer_choice(labels: list[str], ps: list[float], min_conf: float | None) -> dict:
    ps = _renorm(ps)
    i = max(range(len(ps)), key=ps.__getitem__)
    ab = _abstention(ps[i], min_conf)
    return {
        "type": "choice",
        "label": None if ab["abstained"] else labels[i],
        "argmax": labels[i],
        "probabilities": {l: _r(p) for l, p in zip(labels, ps)},
        "confidence": _r(ps[i]),
        **ab,
    }


def _answer_score(levels: list[str], ps: list[float], min_conf: float | None) -> dict:
    ps = _renorm(ps)
    expected = sum(i * p for i, p in enumerate(ps))
    nearest = min(max(int(round(expected)), 0), len(levels) - 1)
    conf = max(ps)  # mass of the modal level
    ab = _abstention(conf, min_conf)
    return {
        "type": "score",
        "level": None if ab["abstained"] else levels[nearest],
        "expected": _r(expected),  # index into `levels`: 0 .. len-1
        "levels": levels,
        "distribution": {l: _r(p) for l, p in zip(levels, ps)},
        "confidence": _r(conf),
        **ab,
    }


def _answer_noul(ps: list[float], min_conf: float | None) -> dict:
    p_true = ps[1]
    conf = max(p_true, 1 - p_true)
    ab = _abstention(conf, min_conf)
    return {
        "type": "noul",
        "p_true": _r(p_true),
        "answer": None if ab["abstained"] else p_true > 0.5,
        "confidence": _r(conf),
        **ab,
    }
