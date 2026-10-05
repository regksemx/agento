import json
import shutil

import pytest

from agento_brain import contract as C
from agento_brain.backends import OnnxBackend

from conftest import default_heads_json, make_model_dir


def test_valid_dir_loads(model_dir):
    c = C.validate_files(model_dir)
    assert c.run_id == "test-run-1" and c.max_len == 32
    assert c.heads["tier"] == ["haiku", "sonnet", "opus"]
    assert c.temperatures == {"tier": 1.3, "effort": 0.9}
    b = OnnxBackend(model_dir)
    assert b.run_id == "test-run-1"


def _copy(model_dir, tmp_path):
    d = tmp_path / "m"
    shutil.copytree(model_dir, d)
    return d


@pytest.mark.parametrize("fname", ["model.onnx", "tokenizer.json", "heads.json", "meta.json"])
def test_missing_file(model_dir, tmp_path, fname):
    d = _copy(model_dir, tmp_path)
    (d / fname).unlink()
    with pytest.raises(C.ContractError) as e:
        C.validate_files(d)
    assert f"missing required file `{fname}`" in str(e.value)


def test_not_a_directory(tmp_path):
    with pytest.raises(C.ContractError, match="not a directory"):
        C.validate_files(tmp_path / "nope")


def _rewrite(d, **over):
    hj = default_heads_json()
    hj.update(over)
    (d / "heads.json").write_text(json.dumps(hj))


@pytest.mark.parametrize(
    "over,needle",
    [
        ({"heads": {"tier": ["haiku", "sonnet", "opus"]}}, "required head `effort` is missing"),
        ({"heads": {**default_heads_json()["heads"], "plan_first": ["yes", "no"]}}, "`plan_first` labels must be exactly"),
        ({"heads": {**default_heads_json()["heads"], "tier": ["opus", "haiku", "sonnet"]}}, "ascending order"),
        ({"heads": {**default_heads_json()["heads"], "tier": ["haiku", "gpt"]}}, "subset"),
        ({"max_len": 4}, "`max_len`"),
        ({"max_len": "512"}, "`max_len`"),
        ({"input_template": "no placeholder"}, "{text}"),
        ({"temperatures": {"nope": 1.0}}, "unknown head `nope`"),
        ({"temperatures": {"tier": 0}}, "temperatures.tier"),
        ({"thresholds": {"abstain": {"tier": 1.5}}}, "thresholds.abstain.tier"),
        ({"thresholds": {"yes": {"tier": 0.5}}}, "only applies to binary heads"),
        ({"thresholds": {"bogus": {}}}, "not a known key"),
    ],
)
def test_bad_heads_json(model_dir, tmp_path, over, needle):
    d = _copy(model_dir, tmp_path)
    _rewrite(d, **over)
    with pytest.raises(C.ContractError) as e:
        C.validate_files(d)
    assert needle in str(e.value)


def test_meta_problems_and_sha(model_dir, tmp_path):
    d = _copy(model_dir, tmp_path)
    (d / "meta.json").write_text(json.dumps({"metrics": []}))
    with pytest.raises(C.ContractError) as e:
        C.validate_files(d)
    assert "run_id" in str(e.value) and "metrics" in str(e.value)
    (d / "meta.json").write_text(json.dumps({"run_id": "x", "model_sha256": "0" * 64}))
    with pytest.raises(C.ContractError, match="does not match"):
        C.validate_files(d)


def test_all_problems_reported_at_once(model_dir, tmp_path):
    d = _copy(model_dir, tmp_path)
    (d / "meta.json").unlink()
    _rewrite(d, max_len=1, input_template="x")
    with pytest.raises(C.ContractError) as e:
        C.validate_files(d)
    assert len(e.value.problems) == 3


def test_malformed_json(model_dir, tmp_path):
    d = _copy(model_dir, tmp_path)
    (d / "heads.json").write_text("{not json")
    with pytest.raises(C.ContractError, match="unreadable JSON"):
        C.validate_files(d)


def test_onnx_missing_output_head(tmp_path):
    d = make_model_dir(tmp_path / "m", drop_output="delegate_explore")
    with pytest.raises(C.ContractError, match="missing output `logits_delegate_explore`"):
        OnnxBackend(d, warmup=False)


def test_onnx_wrong_class_count(tmp_path):
    d = make_model_dir(tmp_path / "m", wrong_classes="tier")
    with pytest.raises(C.ContractError, match="has 4 classes"):
        OnnxBackend(d, warmup=False)


def test_corrupt_onnx(model_dir, tmp_path):
    d = _copy(model_dir, tmp_path)
    (d / "model.onnx").write_bytes(b"garbage")
    with pytest.raises(C.ContractError, match="cannot load"):
        OnnxBackend(d, warmup=False)
