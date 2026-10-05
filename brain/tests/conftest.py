from __future__ import annotations

import http.client
import json
import shutil
import socket
import tempfile
import threading
from pathlib import Path

import numpy as np
import pytest

VOCAB_WORDS = (
    "[ ] = lang en ru repo unknown ctx files_in_repo start prev_task none git_dirty 0 mentions session mid "
    "fix typo rename design architecture migrate race plan approach add log test the a in of to and "
    "readme md ts py file function module service для и в на"
).split()

D = 8
V = 64
HEADS = {
    "tier": ["haiku", "sonnet", "opus"],
    "effort": ["low", "medium", "high"],
    "plan_first": ["no", "yes"],
    "delegate_explore": ["no", "yes"],
}


def build_tokenizer(path: Path) -> None:
    from tokenizers import Tokenizer, models, normalizers, pre_tokenizers, processors

    vocab = {"[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3}
    for w in VOCAB_WORDS:
        vocab.setdefault(w, len(vocab))
    tok = Tokenizer(models.WordLevel(vocab, unk_token="[UNK]"))
    tok.normalizer = normalizers.Lowercase()
    tok.pre_tokenizer = pre_tokenizers.Whitespace()
    tok.post_processor = processors.TemplateProcessing(
        single="[CLS] $A [SEP]", special_tokens=[("[CLS]", 2), ("[SEP]", 3)]
    )
    tok.save(str(path))


def build_weights(seed: int = 7) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    w = {"emb": rng.normal(0, 1.0, (V, D)).astype(np.float32)}
    for h, labels in HEADS.items():
        w[f"W_{h}"] = rng.normal(0, 1.5, (D, len(labels))).astype(np.float32)
        w[f"b_{h}"] = rng.normal(0, 0.2, (len(labels),)).astype(np.float32)
    return w


def build_onnx(path: Path, weights: dict[str, np.ndarray], *, drop_output: str | None = None, wrong_classes: str | None = None) -> None:
    """Hashed bag-of-words: Gather(emb, ids mod V) -> masked mean -> one linear layer per head."""
    import onnx
    from onnx import TensorProto as T
    from onnx import helper as h
    from onnx import numpy_helper as nh

    inits = [nh.from_array(weights["emb"], "emb"), nh.from_array(np.array(V, dtype=np.int64), "V"),
             nh.from_array(np.array([2], dtype=np.int64), "ax2"), nh.from_array(np.array([1], dtype=np.int64), "ax1"),
             nh.from_array(np.array(1e-6, dtype=np.float32), "eps")]
    nodes = [
        h.make_node("Mod", ["input_ids", "V"], ["hid"]),
        h.make_node("Gather", ["emb", "hid"], ["e"], axis=0),            # [B,L,D]
        h.make_node("Cast", ["attention_mask"], ["mf"], to=T.FLOAT),      # [B,L]
        h.make_node("Unsqueeze", ["mf", "ax2"], ["m3"]),                  # [B,L,1]
        h.make_node("Mul", ["e", "m3"], ["em"]),
        h.make_node("ReduceSum", ["em", "ax1"], ["sum"], keepdims=0),     # [B,D]
        h.make_node("ReduceSum", ["m3", "ax1"], ["cnt"], keepdims=0),     # [B,1]
        h.make_node("Add", ["cnt", "eps"], ["cnt2"]),
        h.make_node("Div", ["sum", "cnt2"], ["pooled"]),
    ]
    outputs = []
    for head, labels in HEADS.items():
        n = len(labels) + (1 if wrong_classes == head else 0)
        W, b = weights[f"W_{head}"], weights[f"b_{head}"]
        if n != len(labels):
            W = np.concatenate([W, W[:, :1]], axis=1)
            b = np.concatenate([b, b[:1]])
        inits += [nh.from_array(W, f"W_{head}"), nh.from_array(b, f"b_{head}")]
        out = f"logits_{head}"
        if drop_output == head:
            out = f"renamed_{head}"
        nodes += [h.make_node("MatMul", ["pooled", f"W_{head}"], [f"mm_{head}"]),
                  h.make_node("Add", [f"mm_{head}", f"b_{head}"], [out])]
        outputs.append(h.make_tensor_value_info(out, T.FLOAT, ["batch", n]))
    graph = h.make_graph(
        nodes, "tiny_router",
        [h.make_tensor_value_info("input_ids", T.INT64, ["batch", "seq"]),
         h.make_tensor_value_info("attention_mask", T.INT64, ["batch", "seq"])],
        outputs, initializer=inits,
    )
    model = h.make_model(graph, opset_imports=[h.make_opsetid("", 13)], ir_version=8)
    onnx.checker.check_model(model)
    onnx.save(model, str(path))


def reference_probs(weights: dict[str, np.ndarray], ids: list[int], temps: dict[str, float]) -> dict[str, np.ndarray]:
    pooled = weights["emb"][np.asarray(ids) % V].mean(axis=0)
    out = {}
    for head in HEADS:
        z = (pooled @ weights[f"W_{head}"] + weights[f"b_{head}"]) / temps.get(head, 1.0)
        e = np.exp(z - z.max())
        out[head] = e / e.sum()
    return out


def default_heads_json(**over) -> dict:
    d = {
        "heads": HEADS,
        "max_len": 32,
        "temperatures": {"tier": 1.3, "effort": 0.9},
        "thresholds": {"abstain": {"tier": 0.0, "effort": 0.0}, "yes": {"plan_first": 0.5, "delegate_explore": 0.5}},
        "input_template": "[lang={lang}][repo={repo}][ctx={ctx}][start={start}]\n{text}",
    }
    d.update(over)
    return d


def make_model_dir(root: Path, *, heads_json: dict | None = None, meta: dict | None = None, seed: int = 7, **onnx_kw) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    build_onnx(root / "model.onnx", build_weights(seed), **onnx_kw)
    build_tokenizer(root / "tokenizer.json")
    (root / "heads.json").write_text(json.dumps(heads_json or default_heads_json()))
    (root / "meta.json").write_text(json.dumps(meta or {"run_id": "test-run-1", "metrics": {"agreement": 0.9}}))
    return root


@pytest.fixture(scope="session")
def model_dir(tmp_path_factory) -> Path:
    return make_model_dir(tmp_path_factory.mktemp("model"))


@pytest.fixture
def short_tmp():
    """AF_UNIX paths are limited to ~104 bytes; pytest's tmp_path is often longer."""
    d = Path(tempfile.mkdtemp(prefix="ab", dir="/tmp"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


class UnixConn(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 10) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


class Client:
    def __init__(self, path: str) -> None:
        self.path = path

    def request(self, method: str, url: str, body=None, raw: bytes | None = None):
        c = UnixConn(self.path)
        try:
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            c.request(method, url, body=data, headers={"Content-Type": "application/json"})
            r = c.getresponse()
            return r.status, json.loads(r.read() or b"null")
        finally:
            c.close()

    def get(self, url):
        return self.request("GET", url)

    def post(self, url, body=None, raw=None):
        return self.request("POST", url, body, raw)


def start_server(service, sock_path: Path):
    from agento_brain.server import make_server

    srv = make_server(service, socket_path=sock_path)
    t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    return srv, t


@pytest.fixture
def onnx_client(model_dir, short_tmp):
    from agento_brain.backends import OnnxBackend
    from agento_brain.service import Service

    svc = Service(OnnxBackend(model_dir))
    srv, t = start_server(svc, short_tmp / "b.sock")
    yield Client(str(short_tmp / "b.sock")), svc
    srv.shutdown()
    srv.server_close()


@pytest.fixture
def rules_client(short_tmp):
    from agento_brain.backends import RulesBackend
    from agento_brain.service import Service

    svc = Service(RulesBackend())
    srv, t = start_server(svc, short_tmp / "r.sock")
    yield Client(str(short_tmp / "r.sock")), svc
    srv.shutdown()
    srv.server_close()
