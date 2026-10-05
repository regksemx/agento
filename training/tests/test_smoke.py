"""The pipeline wires end to end on CPU with tiny models (needs torch/transformers/onnxruntime/laya and the HF cache)."""
import argparse
import json
from pathlib import Path

import pytest

pytest.importorskip("torch")
pytest.importorskip("transformers")
pytest.importorskip("onnxruntime")
pytest.importorskip("laya")
pytestmark = pytest.mark.slow


def _args(tmp_path, run_id):
    from agento_train import distill, pipeline, teacher

    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default="")
    ap.add_argument("--judge-dir", default=None)
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--out-root", default=str(tmp_path))
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--max-state-tokens", type=int, default=840)
    ap.add_argument("--holdout-project", action="append", default=[])
    teacher.add_args(ap)
    distill.add_args(ap)
    return ap.parse_args(["--smoke", "--run-id", run_id, "--holdout-project", "gamma"])


@pytest.mark.parametrize("force_port", [False, True])
def test_pipeline_smoke(tmp_path, monkeypatch, force_port):
    from agento_train import pipeline

    if force_port:
        monkeypatch.setenv("AGENTO_FORCE_LAYA_PORT", "1")
    root = pipeline.run(_args(tmp_path, "smoke"), log=lambda *_: None)
    t = json.loads((root / "teacher" / "metrics.json").read_text())
    s = json.loads((root / "student" / "metrics.json").read_text())
    assert t["laya_train"] == ("port" if force_port else t["laya_train"])
    assert t["laya_runtime_check"]["ok"] and t["laya_runtime_check"]["max_tier_prob_diff"] < 0.02
    assert "holdout" in t["eval"]  # project holdout was exercised
    assert s["onnx_fp32"]["parity"]["ok"] and s["onnx_fp32"]["parity"]["agreement"] >= 0.99
    assert s["onnx_int8"]["kept"] in (True, False) and (s["onnx_int8"]["kept"] or s["onnx_int8"]["reason"])
    assert s["onnx_fp32"]["latency"]["p50_ms"] > 0
    md = (root / "report.md").read_text()
    assert "## Teacher" in md and "## Student" in md and "always-opus" in md
    model = root / "student" / "model"
    for f in ("model.onnx", "tokenizer.json", "heads.json", "meta.json"):
        assert (model / f).is_file()
    heads = json.loads((model / "heads.json").read_text())
    from agento_train.textin import INPUT_TEMPLATE

    assert heads["input_template"] == INPUT_TEMPLATE and heads["heads"]["plan_first"] == ["no", "yes"]
    assert json.loads((model / "meta.json").read_text())["run_id"] == "smoke"
    check = s["brain_check"]
    assert check["ok"] in (True, None)  # None only when agento_brain is not installed
    # no prompt text in anything that is pulled back
    for name in ("report.md", "metrics.json"):
        assert "Исправь" not in (root / name).read_text()


def test_laya_loop_flag_runs_upstream_train_model(tmp_path):
    from agento_train import export, teacher
    from agento_train.smoke import make_tiny_checkpoint, write_synthetic_tasks

    tasks = write_synthetic_tasks(tmp_path / "in" / "tasks.jsonl", n=60)
    export.export(tasks, tmp_path / "data", None, log=lambda *_: None)
    ck = make_tiny_checkpoint(tmp_path / "tiny")
    m = teacher.run(tmp_path / "data", tmp_path / "t", checkpoint_dir=str(ck), epochs=1, micro_batch=4, grad_accum=1, device="cpu",
                    laya_loop=True, min_abstain_n=5, log=lambda *_: None)
    assert m["loop"] == "laya.train.train_model" and m["train"]["loss_per_epoch"]


def test_weighted_row_loss_equals_upstream_mean():
    import torch

    from agento_train.laya_compat import load_train
    from agento_train.teacher import rlcd_row_loss

    lt, _ = load_train()
    torch.manual_seed(0)
    logits = torch.randn(4, 3)
    mask = torch.ones(4, 3, dtype=torch.bool)
    target = torch.softmax(torch.randn(4, 3), -1)
    qtype = torch.zeros(4, dtype=torch.long)
    torch.manual_seed(5)
    a = rlcd_row_loss(logits, target, mask, qtype, 0.3, 4, 0.75, 1.0).mean()
    torch.manual_seed(5)
    b = lt.rlcd_loss(logits, target, mask, qtype, 0.3, 4, 0.75, 1.0)
    assert torch.allclose(a, b, atol=1e-6)
