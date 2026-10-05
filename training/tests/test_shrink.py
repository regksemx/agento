"""`distill.shrink_embeddings_fp16`: the lookup table becomes fp16, the graph still computes in fp32."""
import numpy as np
import pytest

onnx = pytest.importorskip("onnx")
ort = pytest.importorskip("onnxruntime")


def test_shrink_embeddings_fp16(tmp_path):
    from onnx import TensorProto, helper, numpy_helper

    from agento_train.distill import shrink_embeddings_fp16

    rng = np.random.default_rng(0)
    emb = rng.normal(size=(1000, 16)).astype(np.float32)
    w = rng.normal(size=(16, 4)).astype(np.float32)
    g = helper.make_graph(
        [helper.make_node("Gather", ["emb", "ids"], ["h"]), helper.make_node("MatMul", ["h", "w"], ["y"])], "g",
        [helper.make_tensor_value_info("ids", TensorProto.INT64, [1, "s"])], [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, "s", 4])],
        [numpy_helper.from_array(emb, "emb"), numpy_helper.from_array(w, "w")])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    path = tmp_path / "m.onnx"
    onnx.save(m, str(path))
    ids = rng.integers(0, 1000, size=(1, 9), dtype=np.int64)
    before = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"ids": ids})[0]
    size = path.stat().st_size

    assert shrink_embeddings_fp16(path, min_elems=10_000)["tables"] == ["emb"]
    assert path.stat().st_size < size * 0.7
    after = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"ids": ids})[0]
    assert after.dtype == np.float32 and np.abs(before - after).max() < 5e-3
    assert shrink_embeddings_fp16(path, min_elems=10_000_000)["tables"] == []  # below the threshold: untouched
