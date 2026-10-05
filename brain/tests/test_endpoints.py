import numpy as np
import pytest

from conftest import HEADS, build_weights, reference_probs


def test_healthz(onnx_client):
    c, svc = onnx_client
    s, b = c.get("/healthz")
    assert s == 200 and b["ok"] is True and b["model_run_id"] == "test-run-1" and b["backend"] == "onnx"
    assert "loaded_at" in b and "p50_ms" in b


def test_route_shape_and_numeric_parity(onnx_client):
    c, svc = onnx_client
    ctx = {"context_tokens": 82000, "repo": ["kotlin"], "start": "session"}
    s, b = c.post("/v1/route", {"text": "fix typo in readme", "context": ctx})
    assert s == 200
    assert set(b) >= {"tier", "effort", "plan_first", "delegate_explore", "confidence", "abstain", "latency_ms", "model_run_id"}
    assert b["tier"] in HEADS["tier"] and b["effort"] in HEADS["effort"]
    assert isinstance(b["plan_first"], bool) and isinstance(b["delegate_explore"], bool)
    assert b["model_run_id"] == "test-run-1" and b["latency_ms"] > 0
    # compare against a numpy re-implementation of the tiny graph (same tokenization, temperatures applied)
    ids = svc.backend.encode("fix typo in readme", ctx)
    ref = reference_probs(build_weights(), ids, {"tier": 1.3, "effort": 0.9})
    assert b["tier"] == HEADS["tier"][int(ref["tier"].argmax())]
    assert b["confidence"] == pytest.approx(float(ref["tier"].max()), abs=1e-5)
    assert b["plan_first"] == bool(ref["plan_first"][1] > 0.5)


def test_route_errors(onnx_client):
    c, _ = onnx_client
    assert c.post("/v1/route", {"context": {}})[0] == 400
    assert c.post("/v1/route", {"text": 5})[0] == 400
    assert c.post("/v1/route", {"text": "x", "context": []})[0] == 400
    s, b = c.post("/v1/route", raw=b"{oops")
    assert s == 400 and b["error"]["code"] == "bad_json"
    assert c.get("/nope")[0] == 404
    assert c.get("/v1/route")[0] == 405


def test_route_abstains_below_threshold(model_dir, short_tmp):
    import json, shutil
    from agento_brain.backends import OnnxBackend
    from agento_brain.service import Service
    from conftest import Client, default_heads_json, start_server

    d = short_tmp / "m"
    shutil.copytree(model_dir, d)
    hj = default_heads_json(thresholds={"abstain": {"tier": 0.999999}})
    (d / "heads.json").write_text(json.dumps(hj))
    srv, _ = start_server(Service(OnnxBackend(d)), short_tmp / "a.sock")
    try:
        s, b = Client(str(short_tmp / "a.sock")).post("/v1/route", {"text": "design the architecture"})
        assert s == 200 and b["abstain"] is True
    finally:
        srv.shutdown(); srv.server_close()


def test_text_list_accepted(onnx_client):
    c, _ = onnx_client
    s, _ = c.post("/v1/route", {"text": ["fix typo", "also rename"], "context": {}})
    assert s == 200


QUESTIONS = {
    "tier": {"type": "choice"},
    "effort": {"type": "score"},
    "plan_first": {"type": "noul"},
    "delegate_explore": {"type": "noul"},
}


def test_systemone_all_question_types(onnx_client):
    c, svc = onnx_client
    s, b = c.post("/v1/systemone", {"state": {"text": "design the architecture", "context": {"start": "session"}}, "questions": QUESTIONS})
    assert s == 200, b
    a = b["answers"]
    assert b["usage"]["output_tokens"] == 0 and b["usage"]["input_tokens"] > 3
    assert b["model_run_id"] == "test-run-1"

    t = a["tier"]
    assert t["type"] == "choice" and t["label"] == t["argmax"] and t["label"] in HEADS["tier"]
    assert set(t["probabilities"]) == set(HEADS["tier"]) and sum(t["probabilities"].values()) == pytest.approx(1, abs=1e-4)
    assert t["confidence"] == pytest.approx(max(t["probabilities"].values()))
    assert t["abstained"] is False and t["min_confidence"] is None

    e = a["effort"]
    assert e["type"] == "score" and e["level"] in HEADS["effort"] and 0 <= e["expected"] <= 2
    assert e["levels"] == HEADS["effort"] and sum(e["distribution"].values()) == pytest.approx(1, abs=1e-4)
    exp = sum(i * p for i, p in enumerate(e["distribution"].values()))
    assert e["expected"] == pytest.approx(exp, abs=1e-4)

    for k in ("plan_first", "delegate_explore"):
        n = a[k]
        assert n["type"] == "noul" and 0 <= n["p_true"] <= 1
        assert n["answer"] == (n["p_true"] > 0.5)
        assert n["confidence"] == pytest.approx(max(n["p_true"], 1 - n["p_true"]))


def test_systemone_consistent_with_route(onnx_client):
    c, _ = onnx_client
    body = {"text": "rename the log in readme", "context": {"start": "mid"}}
    _, r = c.post("/v1/route", body)
    _, s = c.post("/v1/systemone", {"state": body, "questions": QUESTIONS})
    assert s["answers"]["tier"]["label"] == r["tier"]
    assert s["answers"]["effort"]["level"] == r["effort"]


def test_systemone_abstention(onnx_client):
    c, _ = onnx_client
    st = {"text": "fix typo"}
    _, hi = c.post("/v1/systemone", {"state": st, "questions": QUESTIONS, "min_confidence": 0.999999})
    for name, a in hi["answers"].items():
        assert a["abstained"] is True and a["min_confidence"] == 0.999999, name
    assert hi["answers"]["tier"]["label"] is None and hi["answers"]["tier"]["argmax"] in HEADS["tier"]
    assert hi["answers"]["effort"]["level"] is None
    assert hi["answers"]["plan_first"]["answer"] is None
    _, lo = c.post("/v1/systemone", {"state": st, "questions": QUESTIONS, "min_confidence": 0.0})
    assert all(a["abstained"] is False for a in lo["answers"].values())
    # per-question override beats the request-level value
    _, mix = c.post("/v1/systemone", {"state": st, "questions": {"tier": {"type": "choice", "min_confidence": 0.0}, "effort": {"type": "score"}}, "min_confidence": 0.999999})
    assert mix["answers"]["tier"]["abstained"] is False and mix["answers"]["effort"]["abstained"] is True


def test_systemone_options_subset_and_head_alias(onnx_client):
    c, _ = onnx_client
    q = {"small_or_big": {"type": "choice", "head": "tier", "options": ["sonnet", "opus"]}}
    s, b = c.post("/v1/systemone", {"state": {"text": "design"}, "questions": q})
    assert s == 200
    p = b["answers"]["small_or_big"]["probabilities"]
    assert set(p) == {"sonnet", "opus"} and sum(p.values()) == pytest.approx(1, abs=1e-4)


def test_systemone_flat_state(onnx_client):
    c, _ = onnx_client
    s, _ = c.post("/v1/systemone", {"state": {"text": "x", "start": "session", "ctx": 5000}, "questions": {"tier": {"type": "choice"}}})
    assert s == 200


@pytest.mark.parametrize(
    "body,code",
    [
        ({"state": {"text": "x"}, "questions": {"bogus": {"type": "choice"}}}, "unknown_question"),
        ({"state": {"text": "x"}, "questions": {"tier": {"type": "regress"}}}, "unknown_question_type"),
        ({"state": {"text": "x"}, "questions": {"tier": {"type": "noul"}}}, "bad_question"),
        ({"state": {"text": "x"}, "questions": {"tier": {"type": "choice", "options": ["gpt", "opus"]}}}, "bad_question"),
        ({"state": {"text": "x"}, "questions": {}}, "bad_request"),
        ({"state": {"text": "x"}, "questions": {"tier": {"type": "choice"}}, "min_confidence": 2}, "bad_request"),
        ({"state": {}, "questions": {"tier": {"type": "choice"}}}, "bad_request"),
        ({"questions": {"tier": {"type": "choice"}}}, "bad_request"),
    ],
)
def test_systemone_400s(onnx_client, body, code):
    c, _ = onnx_client
    s, b = c.post("/v1/systemone", body)
    assert s == 400 and b["error"]["code"] == code
    assert b["error"]["message"]


def test_unknown_question_message_lists_supported(onnx_client):
    c, _ = onnx_client
    _, b = c.post("/v1/systemone", {"state": {"text": "x"}, "questions": {"bogus": {"type": "choice"}}})
    assert "bogus" in b["error"]["message"] and "tier" in b["error"]["message"]


def test_latency_stats_populate(onnx_client):
    c, svc = onnx_client
    for _ in range(20):
        c.post("/v1/route", {"text": "fix typo"})
    s, h = c.get("/healthz")
    assert h["requests"] >= 20 and h["p50_ms"] > 0 and h["p95_ms"] >= h["p50_ms"]


def test_keepalive_connection_reuse(onnx_client):
    import json
    from conftest import UnixConn

    c, _ = onnx_client
    conn = UnixConn(c.path)
    for _ in range(3):
        conn.request("POST", "/v1/route", body=json.dumps({"text": "fix typo"}))
        r = conn.getresponse()
        assert r.status == 200
        r.read()
    conn.close()


def test_concurrent_requests(onnx_client):
    import threading

    c, _ = onnx_client
    results = []

    def work():
        for _ in range(10):
            results.append(c.post("/v1/route", {"text": "design the architecture"})[1]["tier"])

    ts = [threading.Thread(target=work) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(results) == 60 and len(set(results)) == 1  # deterministic across threads


def test_head_tail_on_long_prompt(onnx_client):
    c, svc = onnx_client
    long = "fix typo " * 500
    ids = svc.backend.encode(long, {})
    assert len(ids) == 32 and ids[0] == 2 and ids[-1] == 3  # [CLS] .. [SEP] kept
    s, _ = c.post("/v1/route", {"text": long})
    assert s == 200


def test_rules_backend_endpoints(rules_client):
    c, _ = rules_client
    s, h = c.get("/healthz")
    assert h["model_run_id"] == "rules-v1" and h["backend"] == "rules"
    s, b = c.post("/v1/route", {"text": "спроектируй архитектуру очереди", "context": {}})
    assert b["model_run_id"] == "rules-v1"
    assert (b["tier"], b["effort"], b["confidence"], b["plan_first"], b["delegate_explore"], b["abstain"]) == ("opus", "high", 0.6, True, False, False)
    assert b["reasons"] == ["heavy keywords: 2"]
    s, b = c.post("/v1/systemone", {"state": {"text": "fix the typo in README"}, "questions": QUESTIONS, "min_confidence": 0.6})
    assert b["answers"]["tier"]["label"] == "sonnet" and b["answers"]["tier"]["confidence"] == 0.7
    assert b["answers"]["delegate_explore"]["abstained"] is True  # rules have no opinion
    assert b["usage"] == {"input_tokens": 0, "output_tokens": 0}
