"""T35b: distill the teacher into a small student, export ONNX, check parity, optionally quantize, measure CPU latency.

    python -m agento_train.distill --data artifacts/<run>/data --teacher artifacts/<run>/teacher --out artifacts/<run>/student

Student: a small encoder (default `intfloat/multilingual-e5-small`, 118M params but only 21M outside the 250k-token embedding
table; fallback `jhu-clsp/mmBERT-small`; `jhu-clsp/ettin-encoder-150m` stays available via `--student`, see BENCHMARK.md) with mean pooling
and ONE multi-head classifier: tier (3), effort (3), plan_first (2), delegate_explore (2). One forward pass answers all four
questions; the input is the daemon's text (`textin.render(INPUT_TEMPLATE, prompt, context)`), there is no per-question head as in Laya.

Loss, per head and per row: `alpha * KD + (1 - alpha) * w * CE`.
  KD  = tau^2 * KL(teacher^(1/tau) || softmax(student / tau)), teacher = the CALIBRATED teacher probabilities;
  CE  = soft cross-entropy against the label distribution (one-hot, or an L1 judge's probabilities), `w` the record's
        label weight normalised to mean 1 over the train split (L2 1.0 / L1 0.6 / L0 0.3).
Caveat: the teacher saw the train rows, so on them its probabilities are over-confident (near the labels). KD then adds
little on train rows, which is why the student's own temperature is fitted on the calibration split, not inherited.

Artifacts in `--out`: `model/` (model.onnx + tokenizer.json + heads.json + meta.json: the directory `agento-brain serve --model-dir`
loads, validated here with `agento-brain check`), `student.fp32.onnx` (opset 17, inputs input_ids/attention_mask, one
`logits_<head>` output each),
`student.int8.onnx` only when it passes the gate (agreement >= 98% and ECE delta <= 0.02, else it is deleted and the reason
printed), `calibration.json` (per-head temperature, tier threshold), `preds_<split>.jsonl`, `metrics.json`.
Dynamic INT8 is never produced: Laya measured it collapsing agreement (README, issue #790). The INT8 here is STATIC (QDQ,
calibrated on training texts) and must earn its place.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .export import read_jsonl
from .metrics import (
    ece,
    effective_threshold,
    evaluate_rows,
    fit_temperature,
    per_project,
    softmax,
    thresholds_from_calibration,
    to_jsonable,
)
from .questions import HEAD_OPTIONS, HEAD_SIZES, HEADS
from .textin import HEAD_FRAC, INPUT_TEMPLATE, head_tail

DEFAULT_STUDENT = "intfloat/multilingual-e5-small"  # p50 ~35 ms at seq 256 / 4 threads on an M-series Mac, ~280 MB, Russian-capable tokenizer
FALLBACK_STUDENT = "jhu-clsp/mmBERT-small"  # same budget class, a bit slower (~60 ms at seq 256), ~370 MB
DEFAULT_MAX_LEN = 256
OPSET = 17
MIN_AGREEMENT_FP32 = 0.99  # ONNX fp32 vs torch: argmax agreement
MIN_AGREEMENT_INT8 = 0.98  # INT8 vs fp32 student
MAX_ECE_DELTA_INT8 = 0.02
SPLITS = ("train", "calibration", "test", "holdout")


@dataclass
class Example:
    id: str
    split: str
    text: str
    y: dict
    w: dict
    soft: dict
    meta: dict = field(default_factory=dict)
    teacher: Optional[dict] = None  # head -> calibrated teacher probs


# ───────────────────────────────────────────── data ─────────────────────────────────────────────


def load_examples(data_dir: Path, teacher_dir: Optional[Path]) -> dict[str, list[Example]]:
    """`distill.jsonl` (text, labels, weights) joined with the export rows' meta and the teacher's calibrated probs."""
    meta: dict[str, dict] = {}
    for s in SPLITS:
        p = data_dir / ("%s.jsonl" % s)
        if p.exists():
            for row in read_jsonl(p):
                meta[row["id"]] = row["meta"]
    teacher: dict[str, dict] = {}
    if teacher_dir is not None:
        for s in SPLITS:
            p = teacher_dir / ("preds_%s.jsonl" % s)
            if p.exists():
                for row in read_jsonl(p):
                    teacher[row["id"]] = row["probs"]
    out: dict[str, list[Example]] = {s: [] for s in SPLITS}
    for row in read_jsonl(data_dir / "distill.jsonl"):
        if row["id"] not in meta:
            continue
        out[row["split"]].append(Example(row["id"], row["split"], row["text"], row["y"], row["w"], row["soft"],
                                         meta[row["id"]], teacher.get(row["id"])))
    return out


class Tok:
    """The student's tokenizer exactly as the daemon uses it: the `tokenizers` library on `tokenizer.json`.

    `encode` = `Tokenizer.encode(text)` (the post-processor adds the special tokens), then head/tail truncation at the token
    level, first `ceil(0.75 * max_len)` ids and the last remainder (brain/CONTRACT.md). Training, parity checks and serving
    therefore see the same ids.
    """

    def __init__(self, path: Path, pad_id: int):
        from tokenizers import Tokenizer

        self.tk = Tokenizer.from_file(str(path))
        self.tk.no_truncation()
        self.tk.no_padding()
        self.pad_id = pad_id

    def encode(self, text: str, max_len: int) -> list[int]:
        return head_tail(self.tk.encode(text).ids, max_len, HEAD_FRAC)


def prepare_tokenizer(hf_tok, out_path: Path) -> Tok:
    """Write `tokenizer.json` (no truncation/padding baked in) from the student's HF tokenizer and load it."""
    import tempfile

    from tokenizers import Tokenizer

    with tempfile.TemporaryDirectory() as d:
        hf_tok.save_pretrained(d)
        tk = Tokenizer.from_file(os.path.join(d, "tokenizer.json"))
    tk.no_truncation()
    tk.no_padding()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tk.save(str(out_path))
    pad = hf_tok.pad_token_id
    return Tok(out_path, pad if pad is not None else 0)


def encode(tok: Tok, text: str, max_len: int) -> list[int]:
    return tok.encode(text, max_len)


def collate(encoded: list[list[int]], pad_id: int):
    import torch

    n, L = len(encoded), max(len(e) for e in encoded)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    for i, e in enumerate(encoded):
        ids[i, : len(e)] = torch.tensor(e)
        att[i, : len(e)] = 1
    return ids, att


# ───────────────────────────────────────────── model ─────────────────────────────────────────────


def build_student(name_or_path: str):
    """`(StudentNet, tokenizer)`; the encoder runs with sdpa attention and no `torch.compile`, so it traces to ONNX."""
    import torch
    from torch import nn
    from transformers import AutoConfig, AutoModel, AutoTokenizer

    cfg = AutoConfig.from_pretrained(name_or_path)
    if hasattr(cfg, "reference_compile"):
        cfg.reference_compile = False
    try:
        enc = AutoModel.from_pretrained(name_or_path, config=cfg, attn_implementation="sdpa")
    except (ValueError, TypeError, ImportError):
        enc = AutoModel.from_pretrained(name_or_path, config=cfg)
    tok = AutoTokenizer.from_pretrained(name_or_path)

    class StudentNet(nn.Module):
        def __init__(self, encoder):
            super().__init__()
            self.encoder = encoder
            d = encoder.config.hidden_size
            self.trunk = nn.Sequential(nn.Dropout(0.1), nn.Linear(d, d), nn.GELU(), nn.Dropout(0.1))
            self.heads = nn.ModuleDict({h: nn.Linear(d, n) for h, n in HEAD_SIZES.items()})

        def forward(self, input_ids, attention_mask):
            h = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
            m = attention_mask.unsqueeze(-1).to(h.dtype)
            pooled = (h * m).sum(1) / m.sum(1).clamp(min=1.0)
            z = self.trunk(pooled)
            return tuple(self.heads[k](z) for k in HEADS)

    return StudentNet(enc), tok


def kd_loss(student_logits, teacher_probs, tau: float):
    """tau^2 * KL(teacher^(1/tau) || softmax(student / tau)) per row."""
    import torch

    t = torch.softmax(torch.log(teacher_probs.clamp_min(1e-9)) / tau, -1)
    logp_s = torch.log_softmax(student_logits / tau, -1)
    return (t * (torch.log(t.clamp_min(1e-9)) - logp_s)).sum(-1) * tau * tau


def ce_loss(student_logits, soft):
    import torch

    return -(soft * torch.log_softmax(student_logits, -1)).sum(-1)


def train_student(model, tok, train: list[Example], device, max_len: int, epochs: int = 12, batch_size: int = 16,
                  lr: float = 5e-5, head_lr: float = 3e-4, alpha: float = 0.5, tau: float = 2.0, seed: int = 0,
                  max_steps: Optional[int] = None, log=print) -> list[float]:
    import torch

    if not train:
        raise SystemExit("distill: no train examples")
    torch.manual_seed(seed)
    rng = random.Random(seed)
    encoded = [encode(tok, ex.text, max_len) for ex in train]
    wmean = {h: float(np.mean([ex.w.get(h, 1.0) for ex in train if h in ex.w]) or 1.0) for h in HEADS}
    use_kd = alpha > 0 and all(ex.teacher is not None for ex in train)
    if alpha > 0 and not use_kd:
        log("distill: teacher probabilities missing for some train rows, KD off (label loss only)")
    enc_params = [p for n, p in model.named_parameters() if n.startswith("encoder.")]
    head_params = [p for n, p in model.named_parameters() if not n.startswith("encoder.")]
    opt = torch.optim.AdamW([{"params": enc_params, "lr": lr}, {"params": head_params, "lr": head_lr}], weight_decay=0.01)
    steps_per_epoch = math.ceil(len(train) / batch_size)
    total = max(1, steps_per_epoch * epochs)
    warm = max(1, int(0.06 * total))
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (s + 1) / warm if s < warm else max(0.02, 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, total - warm)))))
    bf16 = device.type == "cuda" and torch.cuda.is_bf16_supported()
    model.to(device).train()
    history: list[float] = []
    step = 0
    stop = False
    for epoch in range(epochs):
        order = list(range(len(train)))
        rng.shuffle(order)
        tot = 0.0
        nb = 0
        for start in range(0, len(order), batch_size):
            idx = order[start : start + batch_size]
            ids, att = collate([encoded[i] for i in idx], tok.pad_id)
            ids, att = ids.to(device), att.to(device)
            with torch.autocast(device.type, dtype=torch.bfloat16, enabled=bf16):
                outs = model(ids, att)
            loss = 0.0
            for h, logits in zip(HEADS, outs):
                logits = logits.float()
                rows = [(j, train[i]) for j, i in enumerate(idx) if h in train[i].y]
                if not rows:
                    continue
                sel = torch.tensor([j for j, _ in rows], device=device)
                lg = logits[sel]
                soft = torch.tensor([ex.soft[h] for _, ex in rows], dtype=torch.float32, device=device)
                w = torch.tensor([ex.w.get(h, 1.0) / wmean[h] for _, ex in rows], dtype=torch.float32, device=device)
                head_loss = (1 - alpha if use_kd else 1.0) * (w * ce_loss(lg, soft))
                if use_kd:
                    tp = torch.tensor([ex.teacher[h] for _, ex in rows], dtype=torch.float32, device=device)
                    head_loss = head_loss + alpha * kd_loss(lg, tp, tau)
                loss = loss + head_loss.mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            tot += float(loss.item())
            nb += 1
            step += 1
            if max_steps is not None and step >= max_steps:
                stop = True
                break
        history.append(tot / max(1, nb))
        log("distill: epoch %d/%d loss %.4f" % (epoch + 1, epochs, history[-1]))
        if stop:
            break
    model.eval()
    return history


def predict_logits(model, tok, examples: list[Example], device, max_len: int, batch_size: int = 32) -> dict[str, np.ndarray]:
    """Student logits for `examples`: `{head: (N, K)}` in the order of `examples` (batches sorted by length)."""
    import torch

    model.to(device).eval()
    encoded = [encode(tok, ex.text, max_len) for ex in examples]
    order = sorted(range(len(encoded)), key=lambda i: len(encoded[i]))
    out = {h: np.zeros((len(examples), HEAD_SIZES[h]), dtype=np.float64) for h in HEADS}
    with torch.no_grad():
        for start in range(0, len(order), batch_size):
            idx = order[start : start + batch_size]
            ids, att = collate([encoded[i] for i in idx], tok.pad_id)
            outs = model(ids.to(device), att.to(device))
            for h, lg in zip(HEADS, outs):
                out[h][idx] = lg.float().cpu().numpy()
    return out


def pred_rows(examples: list[Example], logits: dict[str, np.ndarray], temps: dict[str, float]) -> list[dict]:
    rows = []
    for i, ex in enumerate(examples):
        rows.append({"id": ex.id, "split": ex.split, "meta": ex.meta,
                     "logits": {h: logits[h][i].tolist() for h in HEADS},
                     "probs": {h: softmax(logits[h][i], temps[h]).tolist() for h in HEADS}})
    return rows


def fit_head_temperatures(examples: list[Example], logits: dict[str, np.ndarray]) -> dict[str, float]:
    temps = {}
    for h in HEADS:
        sel = [i for i, ex in enumerate(examples) if h in ex.y]
        if not sel:
            temps[h] = 1.0
            continue
        temps[h] = fit_temperature(logits[h][sel], np.array([examples[i].soft[h] for i in sel]))
    return temps


# ───────────────────────────────────────────── ONNX ─────────────────────────────────────────────


def export_onnx(model, path: Path, opset: int = OPSET) -> None:
    """fp32 ONNX: inputs `input_ids`, `attention_mask` (batch and sequence dynamic), outputs `<head>_logits`."""
    import torch

    model.cpu().float().eval()
    ids = torch.randint(5, 100, (2, 17), dtype=torch.long)  # batch and length > 1 and distinct, so nothing is specialised
    att = torch.ones_like(ids)
    out_names = ["logits_%s" % h for h in HEADS]
    axes = {"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"}}
    axes.update({n: {0: "batch"} for n in out_names})
    path.parent.mkdir(parents=True, exist_ok=True)
    kwargs = dict(input_names=["input_ids", "attention_mask"], output_names=out_names, dynamic_axes=axes,
                  opset_version=opset, do_constant_folding=True)
    try:
        torch.onnx.export(model, (ids, att), str(path), dynamo=False, **kwargs)  # TorchScript exporter: honours opset 17
    except Exception as e:  # noqa: BLE001
        print("distill: TorchScript ONNX export failed (%s: %s); trying the dynamo exporter" % (type(e).__name__, str(e)[:200]))
        torch.onnx.export(model, (ids, att), str(path), dynamo=True, **{k: v for k, v in kwargs.items() if k != "dynamic_axes"},
                          dynamic_shapes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"}})


def shrink_embeddings_fp16(path: Path, min_elems: int = 5_000_000) -> dict:
    """Store the big word-embedding table(s) as fp16 and `Cast` the Gather output back to fp32, in place.

    Multilingual encoders spend most of their weights on a 250k-token embedding matrix (mmBERT-small: 98M of 140M params), which
    is a lookup, not compute: fp16 storage halves those bytes (-190 MB for mmBERT-small) at no latency cost, and the rounding
    (fp16 has 11 mantissa bits) is far below fine-tuning noise; the ONNX-vs-torch parity gate still runs on the result.
    Only Gather tables with >= `min_elems` elements whose every consumer is a Gather are touched. Returns the byte saving.
    """
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    m = onnx.load(str(path))
    inits = {i.name: i for i in m.graph.initializer}
    users: dict[str, list] = {}
    for n in m.graph.node:
        for x in n.input:
            users.setdefault(x, []).append(n)
    done, saved = [], 0
    for name, init in inits.items():
        if init.data_type != TensorProto.FLOAT or int(np.prod(init.dims)) < min_elems or len(init.dims) != 2:
            continue
        if not users.get(name) or any(n.op_type != "Gather" or n.input[0] != name for n in users[name]):
            continue
        arr = numpy_helper.to_array(init)
        init.CopyFrom(numpy_helper.from_array(arr.astype(np.float16), name))
        saved += arr.nbytes - arr.nbytes // 2
        for n in users[name]:
            idx = list(m.graph.node).index(n)
            out = n.output[0]
            n.output[0] = out + "_fp16"
            m.graph.node.insert(idx + 1, helper.make_node("Cast", [out + "_fp16"], [out], to=TensorProto.FLOAT, name=n.name + "_cast_fp32"))
        done.append(name)
    if done:
        onnx.save(m, str(path))
    return {"tables": done, "saved_mb": round(saved / 1e6, 1)}


def ort_session(path: Path, threads: Optional[int] = None):
    import onnxruntime as ort

    so = ort.SessionOptions()
    if threads:
        so.intra_op_num_threads = threads
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def ort_logits(sess, tok, examples: list[Example], max_len: int) -> dict[str, np.ndarray]:
    """Run every example separately (batch 1: no padding effects) through an ORT session."""
    out = {h: np.zeros((len(examples), HEAD_SIZES[h])) for h in HEADS}
    names = ["logits_%s" % h for h in HEADS]
    for i, ex in enumerate(examples):
        ids = np.array([encode(tok, ex.text, max_len)], dtype=np.int64)
        res = sess.run(names, {"input_ids": ids, "attention_mask": np.ones_like(ids)})
        for h, r in zip(HEADS, res):
            out[h][i] = r[0]
    return out


def agreement(a: dict[str, np.ndarray], b: dict[str, np.ndarray]) -> dict:
    """Argmax agreement (all heads pooled and per head) and the largest probability / logit difference between two logit sets."""
    per, same, total, pmax, lmax = {}, 0, 0, 0.0, 0.0
    for h in HEADS:
        eq = a[h].argmax(1) == b[h].argmax(1)
        per[h] = float(eq.mean()) if len(eq) else float("nan")
        same += int(eq.sum())
        total += len(eq)
        if len(eq):
            pmax = max(pmax, float(np.abs(softmax(a[h]) - softmax(b[h])).max()))
            lmax = max(lmax, float(np.abs(a[h] - b[h]).max()))
    return {"agreement": same / total if total else float("nan"), "per_head": per, "max_prob_diff": pmax, "max_logit_diff": lmax,
            "n": total // len(HEADS)}


def mean_ece(examples: list[Example], logits: dict[str, np.ndarray], temps: dict[str, float]) -> dict:
    """ECE per head against the hard labels, and their mean."""
    per = {}
    for h in HEADS:
        sel = [i for i, ex in enumerate(examples) if h in ex.y]
        if not sel:
            continue
        p = softmax(logits[h][sel], temps[h])
        y = np.array([examples[i].y[h] for i in sel])
        per[h] = ece(p.max(1), (p.argmax(1) == y).astype(float))
    return {"per_head": per, "mean": float(np.mean(list(per.values()))) if per else float("nan")}


def quantize_static_int8(fp32: Path, out: Path, tok, texts: list[str], max_len: int, log=print) -> None:
    """Static INT8 (QDQ, u8 activations / s8 per-channel weights) calibrated on `texts`. Raises on any failure."""
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static

    src = fp32
    try:
        from onnxruntime.quantization.shape_inference import quant_pre_process

        pre = fp32.with_suffix(".pre.onnx")
        quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
        src = pre
    except Exception as e:  # noqa: BLE001 - pre-processing is an optimisation, not a requirement
        log("distill: quant_pre_process skipped (%s)" % type(e).__name__)

    class Reader(CalibrationDataReader):
        def __init__(self):
            self.it = iter(texts)

        def get_next(self):
            t = next(self.it, None)
            if t is None:
                return None
            ids = np.array([encode(tok, t, max_len)], dtype=np.int64)
            return {"input_ids": ids, "attention_mask": np.ones_like(ids)}

    quantize_static(str(src), str(out), Reader(), quant_format=QuantFormat.QDQ, activation_type=QuantType.QUInt8,
                    weight_type=QuantType.QInt8, per_channel=True, op_types_to_quantize=["MatMul", "Gemm"])
    if src != fp32 and src.exists():
        src.unlink()


def latency(path: Path, vocab_size: int, seq_len: int = 512, warmup: int = 10, runs: int = 100, threads: Optional[int] = None) -> dict:
    """CPU latency at batch 1 and sequence length `seq_len` (full, no padding), ms."""
    import onnxruntime as ort

    sess = ort_session(path, threads)
    rng = np.random.default_rng(0)
    ids = rng.integers(5, max(6, vocab_size - 1), size=(1, seq_len), dtype=np.int64)
    feed = {"input_ids": ids, "attention_mask": np.ones_like(ids)}
    for _ in range(warmup):
        sess.run(None, feed)
    ts = []
    for _ in range(runs):
        t0 = time.perf_counter()
        sess.run(None, feed)
        ts.append((time.perf_counter() - t0) * 1000)
    return {"p50_ms": float(np.percentile(ts, 50)), "p95_ms": float(np.percentile(ts, 95)), "mean_ms": float(np.mean(ts)),
            "runs": runs, "seq_len": seq_len, "batch": 1, "threads": threads or os.cpu_count(), "onnxruntime": ort.__version__,
            "file_mb": round(path.stat().st_size / 1e6, 1)}


# ───────────────────────────────────────────── run ─────────────────────────────────────────────


def run(data_dir: Path, teacher_dir: Optional[Path], out_dir: Path, student: str = DEFAULT_STUDENT, epochs: int = 12,
        batch_size: int = 16, lr: float = 5e-5, alpha: float = 0.5, tau: float = 2.0, max_len: int = DEFAULT_MAX_LEN, device: str = "auto",
        max_steps: Optional[int] = None, int8: bool = True, latency_runs: int = 100, latency_seq: Optional[int] = None, seed: int = 0,
        threads: Optional[int] = None, run_id: str = "local", shrink_embeddings: bool = True, log=print) -> dict:
    import torch

    latency_seq = latency_seq or max_len
    out_dir.mkdir(parents=True, exist_ok=True)
    data = load_examples(data_dir, teacher_dir)
    for need in ("train", "calibration", "test"):
        if not data[need]:
            raise SystemExit("distill: no %s examples in %s (run export first)" % (need, data_dir))
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else ("mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
    dev = torch.device(device)
    try:
        model, hf_tok = build_student(student)
    except Exception as e:  # noqa: BLE001
        if student != DEFAULT_STUDENT:
            raise
        log("distill: could not load %s (%s: %s); falling back to %s" % (student, type(e).__name__, str(e)[:160], FALLBACK_STUDENT))
        student = FALLBACK_STUDENT
        model, hf_tok = build_student(student)
    model_dir = out_dir / "model"  # the artifact brain/CONTRACT.md describes
    tok = prepare_tokenizer(hf_tok, model_dir / "tokenizer.json")
    n_params = sum(p.numel() for p in model.parameters())
    log("distill: student %s (%.0fM params), device %s, max_len %d" % (student, n_params / 1e6, dev, max_len))

    t0 = time.time()
    history = train_student(model, tok, data["train"], dev, max_len, epochs, batch_size, lr, alpha=alpha, tau=tau, seed=seed,
                            max_steps=max_steps, log=log)
    train_seconds = time.time() - t0

    # Student calibration: per-head temperature on the calibration split only.
    cal_logits = predict_logits(model, tok, data["calibration"], dev, max_len)
    temps = fit_head_temperatures(data["calibration"], cal_logits)
    logits = {s: (cal_logits if s == "calibration" else predict_logits(model, tok, ex, dev, max_len)) for s, ex in data.items() if ex}
    preds = {s: pred_rows(data[s], logits[s], temps) for s in logits}
    for s, rows in preds.items():
        with open(out_dir / ("preds_%s.jsonl" % s), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(to_jsonable(r), ensure_ascii=False) + "\n")
    tier_fit = thresholds_from_calibration(preds["calibration"])
    effort_fit = thresholds_from_calibration(preds["calibration"], head="effort")
    thr = effective_threshold(tier_fit)

    metrics: dict[str, Any] = {"kind": "student", "student": student, "params_m": n_params / 1e6, "device": str(dev),
                               "max_len": max_len, "train": {"epochs": epochs, "loss_per_epoch": history, "alpha": alpha, "tau": tau,
                                                             "seconds": train_seconds, "kd": all(e.teacher is not None for e in data["train"])},
                               "calibration": {"temperature": temps, "tier_threshold": tier_fit, "effort_threshold": effort_fit},
                               "eval": {}, "per_project": {}, "vs_teacher": {}}
    for s in ("test", "holdout"):
        if preds.get(s):
            metrics["eval"][s] = evaluate_rows(preds[s], thr)
            metrics["per_project"][s] = per_project(preds[s], thr)
            if all(e.teacher is not None for e in data[s]):
                tl = {h: np.array([np.log(np.clip(e.teacher[h], 1e-9, 1)) for e in data[s]]) for h in HEADS}
                metrics["vs_teacher"][s] = agreement({h: logits[s][h] / temps[h] for h in HEADS}, tl)
    metrics["eval"]["calibration"] = evaluate_rows(preds["calibration"], thr)

    # Save the torch student next to the ONNX files.
    torch.save({"state_dict": model.state_dict(), "student": student, "max_len": max_len, "heads": {h: list(HEAD_OPTIONS[h]) for h in HEADS}},
               out_dir / "student.pt")

    # ONNX fp32 + parity against torch, on every non-train example.
    fp32 = out_dir / "student.fp32.onnx"
    export_onnx(model, fp32)
    if shrink_embeddings:
        sh = shrink_embeddings_fp16(fp32)
        if sh["tables"]:
            log("distill: word-embedding table stored as fp16 (-%.0f MB; compute stays fp32)" % sh["saved_mb"])
    parity_set = data["calibration"] + data["test"] + data.get("holdout", [])
    sess = ort_session(fp32, threads)
    ort_fp32 = ort_logits(sess, tok, parity_set, max_len)
    torch_cpu = predict_logits(model, tok, parity_set, torch.device("cpu"), max_len, batch_size=1)
    par = agreement(torch_cpu, ort_fp32)
    par["ok"] = bool(par["agreement"] >= MIN_AGREEMENT_FP32)
    par["threshold"] = MIN_AGREEMENT_FP32
    metrics["onnx_fp32"] = {"parity": par, "opset": OPSET, "latency": latency(fp32, getattr(model.encoder.config, "vocab_size", 30000),
                                                                           latency_seq, runs=latency_runs, threads=threads),
                              "latency_short": latency(fp32, getattr(model.encoder.config, "vocab_size", 30000), 128,
                                                       runs=latency_runs, threads=threads)}
    log("distill: ONNX fp32 parity vs torch: agreement %.4f (need >= %.2f), max prob diff %.2e, max logit diff %.2e -> %s"
        % (par["agreement"], MIN_AGREEMENT_FP32, par["max_prob_diff"], par["max_logit_diff"], "OK" if par["ok"] else "FAIL"))
    lat = metrics["onnx_fp32"]["latency"]
    log("distill: fp32 CPU latency at seq 128 (a typical prompt): p50 %.1f ms" % metrics["onnx_fp32"]["latency_short"]["p50_ms"])
    log("distill: fp32 CPU latency (batch 1, seq %d, %s threads): p50 %.1f ms, p95 %.1f ms, %.0f MB"
        % (latency_seq, lat["threads"], lat["p50_ms"], lat["p95_ms"], lat["file_mb"]))

    # Static INT8, kept only if it passes the gate.
    metrics["onnx_int8"] = {"kept": False, "reason": "disabled (--no-int8)"} if not int8 else {}
    if int8:
        int8_path = out_dir / "student.int8.onnx"
        calib_texts = [e.text for e in data["train"]][:128]
        try:
            quantize_static_int8(fp32, int8_path, tok, calib_texts, max_len, log)
            q_logits = ort_logits(ort_session(int8_path, threads), tok, parity_set, max_len)
            ag = agreement(ort_fp32, q_logits)
            eval_ex = data["test"]
            ex_idx = {id(e): i for i, e in enumerate(parity_set)}
            sel = [ex_idx[id(e)] for e in eval_ex]
            e32 = mean_ece(eval_ex, {h: ort_fp32[h][sel] for h in HEADS}, temps)
            e8 = mean_ece(eval_ex, {h: q_logits[h][sel] for h in HEADS}, temps)
            delta = e8["mean"] - e32["mean"]
            ok = ag["agreement"] >= MIN_AGREEMENT_INT8 and delta <= MAX_ECE_DELTA_INT8
            info = {"kept": bool(ok), "agreement": ag["agreement"], "agreement_per_head": ag["per_head"],
                    "max_prob_diff": ag["max_prob_diff"], "ece_fp32": e32["mean"], "ece_int8": e8["mean"], "ece_delta": delta,
                    "min_agreement": MIN_AGREEMENT_INT8, "max_ece_delta": MAX_ECE_DELTA_INT8}
            if ok:
                info["latency"] = latency(int8_path, getattr(model.encoder.config, "vocab_size", 30000), latency_seq,
                                          runs=latency_runs, threads=threads)
                log("distill: INT8 kept: agreement %.4f, ECE delta %+.4f, p50 %.1f ms" % (ag["agreement"], delta, info["latency"]["p50_ms"]))
            else:
                reasons = []
                if ag["agreement"] < MIN_AGREEMENT_INT8:
                    reasons.append("agreement %.4f < %.2f" % (ag["agreement"], MIN_AGREEMENT_INT8))
                if delta > MAX_ECE_DELTA_INT8:
                    reasons.append("ECE delta %+.4f > %.2f" % (delta, MAX_ECE_DELTA_INT8))
                info["reason"] = "; ".join(reasons)
                int8_path.unlink(missing_ok=True)
                log("distill: INT8 DISCARDED (%s); ship the fp32 model" % info["reason"])
            metrics["onnx_int8"] = info
        except Exception as e:  # noqa: BLE001 - a failed quantization must not fail the run
            int8_path.unlink(missing_ok=True)
            metrics["onnx_int8"] = {"kept": False, "reason": "quantization failed: %s: %s" % (type(e).__name__, str(e)[:200])}
            log("distill: INT8 DISCARDED (%s)" % metrics["onnx_int8"]["reason"])

    # The artifact the daemon loads: model.onnx (int8 only if it passed the gate) + tokenizer.json + heads.json + meta.json.
    chosen = out_dir / "student.int8.onnx" if metrics["onnx_int8"].get("kept") else fp32
    metrics["packaged"] = package_model_dir(model_dir, chosen, temps, tier_fit, effort_fit, max_len, run_id, metrics)
    metrics["brain_check"] = brain_check(model_dir, log)

    with open(out_dir / "calibration.json", "w", encoding="utf-8") as f:
        json.dump(to_jsonable({"temperature": temps, "tier_threshold": tier_fit, "effort_threshold": effort_fit,
                               "heads": {h: list(HEAD_OPTIONS[h]) for h in HEADS}}), f, indent=2)
    with open(out_dir / "metrics.json", "w", encoding="utf-8") as f:
        json.dump(to_jsonable(metrics), f, indent=2)
    if not par["ok"]:
        raise SystemExit("distill: ONNX fp32 does not match torch (agreement %.4f < %.2f); see %s" % (par["agreement"], MIN_AGREEMENT_FP32, out_dir / "metrics.json"))
    if metrics["brain_check"].get("ok") is False:
        raise SystemExit("distill: `agento-brain check` rejected %s:\n%s" % (model_dir, metrics["brain_check"]["output"]))
    return metrics


def package_model_dir(model_dir: Path, onnx: Path, temps: dict, tier_fit: dict, effort_fit: dict, max_len: int, run_id: str,
                      metrics: dict) -> dict:
    """Write `model.onnx`, `heads.json`, `meta.json` next to `tokenizer.json` (brain/CONTRACT.md)."""
    import hashlib
    import shutil

    model_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(onnx, model_dir / "model.onnx")
    sha = hashlib.sha256((model_dir / "model.onnx").read_bytes()).hexdigest()

    def cut(fit: dict) -> float:
        return min(1.0, effective_threshold(fit))  # no safe cut -> 1.0: abstain unless the model is certain

    heads = {
        "heads": {h: list(HEAD_OPTIONS[h]) for h in HEADS},
        "max_len": max_len,
        "temperatures": {h: round(float(temps[h]), 6) for h in HEADS},
        "thresholds": {"abstain": {"tier": cut(tier_fit), "effort": cut(effort_fit)},
                       "yes": {"plan_first": 0.5, "delegate_explore": 0.5}},
        "input_template": INPUT_TEMPLATE,
        "head_frac": HEAD_FRAC,
    }
    test = metrics["eval"]["test"]
    summary = {
        "student": metrics["student"], "precision": "int8" if onnx.name.endswith("int8.onnx") else "fp32",
        "test_n": test["n"], "tier_acc": test["heads"]["tier"]["accuracy"], "tier_ece": test["heads"]["tier"]["ece"],
        "effort_acc": test["heads"]["effort"]["accuracy"], "under_tier": test["policy"]["under_tier"],
        "over_tier": test["policy"]["over_tier"], "savings_conservative": test["policy"]["savings_conservative"],
        "tier_threshold": tier_fit.get("threshold"), "agreement_vs_teacher": metrics["vs_teacher"].get("test", {}).get("agreement"),
        "onnx_parity_agreement": metrics["onnx_fp32"]["parity"]["agreement"],
        "latency_p50_ms": metrics["onnx_fp32"]["latency"]["p50_ms"], "int8": metrics["onnx_int8"].get("kept", False),
    }
    (model_dir / "heads.json").write_text(json.dumps(to_jsonable(heads), indent=2) + "\n", encoding="utf-8")
    (model_dir / "meta.json").write_text(json.dumps(to_jsonable({"run_id": run_id, "model_sha256": sha, "metrics": summary}), indent=2) + "\n",
                                         encoding="utf-8")
    return {"dir": str(model_dir), "onnx": onnx.name, "sha256": sha}


def brain_check(model_dir: Path, log=print) -> dict:
    """Run `agento-brain check <dir>` (the daemon's own contract validation). Skipped when agento_brain is not installed."""
    import subprocess

    proc = subprocess.run([sys.executable, "-m", "agento_brain.cli", "check", str(model_dir)], capture_output=True, text=True)
    out = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0 and "No module named" in out and "agento_brain" in out:
        log("distill: agento-brain not installed, contract check skipped (pip install -e brain)")
        return {"ok": None, "output": "skipped: agento_brain is not installed"}
    log("distill: agento-brain check -> %s" % (out.splitlines()[-1] if out else proc.returncode))
    return {"ok": proc.returncode == 0, "output": out}


def add_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--student", default=DEFAULT_STUDENT, help="encoder id/path (falls back to %s if the default cannot load); e.g. jhu-clsp/ettin-encoder-150m with --student-max-len 512 for the old 150m setup" % FALLBACK_STUDENT)
    ap.add_argument("--student-epochs", type=int, default=12)
    ap.add_argument("--student-batch", type=int, default=16)
    ap.add_argument("--student-lr", type=float, default=5e-5)
    ap.add_argument("--alpha", type=float, default=0.5, help="weight of the KD term (0 = labels only)")
    ap.add_argument("--tau", type=float, default=2.0)
    ap.add_argument("--student-max-len", type=int, default=DEFAULT_MAX_LEN, help="tokens incl. special tokens; head 75%% / tail 25%% truncation (150m or 512 cost ~3x the latency)")
    ap.add_argument("--no-shrink-embeddings", action="store_true", help="keep the word-embedding table fp32 in the ONNX (default: fp16 storage, fp32 compute)")
    ap.add_argument("--student-device", default="auto")
    ap.add_argument("--student-max-steps", type=int, default=None)
    ap.add_argument("--no-int8", action="store_true")
    ap.add_argument("--latency-runs", type=int, default=100)
    ap.add_argument("--threads", type=int, default=None, help="ORT intra-op threads for parity/latency (default: all cores)")


def run_from_args(a: argparse.Namespace, data_dir: Path, teacher_dir: Optional[Path], out_dir: Path, run_id: str = "local",
                  log=print) -> dict:
    return run(data_dir, teacher_dir, out_dir, a.student, a.student_epochs, a.student_batch, a.student_lr, a.alpha, a.tau,
               a.student_max_len, a.student_device, a.student_max_steps, not a.no_int8, a.latency_runs, None, 0, a.threads, run_id, not a.no_shrink_embeddings, log)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--teacher", default=None, help="teacher output directory (preds_*.jsonl); without it the student learns from labels only")
    ap.add_argument("--out", required=True)
    ap.add_argument("--run-id", default="local", help="written to model/meta.json (returned by the daemon as model_run_id)")
    add_args(ap)
    a = ap.parse_args(argv)
    run_from_args(a, Path(a.data), Path(a.teacher) if a.teacher else None, Path(a.out), a.run_id)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)  # onnxruntime + tokenizers threads can abort during interpreter teardown on macOS; the work is done


if __name__ == "__main__":
    sys.exit(main())
