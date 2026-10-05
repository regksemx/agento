"""T35a: fine-tune the Laya teacher on agento tasks, calibrate it, evaluate it.

    python -m agento_train.teacher --data artifacts/<run>/data --out artifacts/<run>/teacher [--checkpoint multilingual]

How Laya's training is used. Laya's repo has one shared RLCD loop, `laya.train` (the notebooks' loop, once). We import its
building blocks (question/target/item construction, `rlcd_loss`, option-order shuffling, checkpoint IO, calibration
records) from the installed library, or from the vendored copy `_laya_port.py` when the installed wheel lacks the module
(`laya_compat.py`). The loop itself, `train_weighted` below, is a line-for-line mirror of `laya.train.train_model` with ONE
change: the loss is multiplied per row by that record's label weight (L2 1.0, L1 0.6, L0 0.3), because `train_model` has no
per-item weights. `--laya-loop` runs upstream's `train_model` unchanged (all weights 1) for an A/B check.

Calibration: temperatures are fitted by `laya.calibrate.fit_temperature_map` on the CALIBRATION split only (time-disjoint
from train and test), exactly as the runtime applies them (per question type, bucket map when a bucket is large enough);
`fit_abstention_thresholds` runs on the same records, and agento's own tier threshold (Clopper-Pearson bound on the
under-routing rate, spec section 6) is fitted there too. Everything is then scored on the TEST split.

Outputs in `--out`: `model/` (a `laya.load`-able checkpoint, temperatures in `rl_agent_config.json`), `calibration.json`,
`preds_<split>.jsonl` (calibrated probs and raw logits, no prompt text), `metrics.json`.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .export import read_jsonl
from .laya_compat import load_train
from .metrics import (
    baseline_predictions,
    effective_threshold,
    evaluate_baselines,
    evaluate_rows,
    per_project,
    softmax,
    thresholds_from_calibration,
    to_jsonable,
)
from .questions import HEADS, LAYA_TYPE

CHECKPOINTS = {
    "multilingual": ("convaiinnovations/laya", "multilingual"),  # mmBERT-base 322M, 1024 tokens, default: prompts are mostly Russian
    "english": ("convaiinnovations/laya", None),  # ModernBERT-large 421M, 512 tokens; collapses outside English
    "typed-decisions": ("convaiinnovations/laya", "typed-decisions"),  # ModernBERT-large, already fine-tuned on typed decisions
}
SPLITS = ("train", "calibration", "test", "holdout")


def fetch_checkpoint(name_or_path: str, revision: Optional[str] = None) -> str:
    """Local directory of a Laya checkpoint: a path as is, or an alias downloaded from the Hub (only that subfolder)."""
    if os.path.isdir(name_or_path):
        return name_or_path
    if name_or_path not in CHECKPOINTS:
        raise SystemExit("teacher: --checkpoint must be a directory or one of %s, got %r" % (sorted(CHECKPOINTS), name_or_path))
    from huggingface_hub import snapshot_download

    repo, sub = CHECKPOINTS[name_or_path]
    prefix = sub + "/" if sub else ""
    kw: dict[str, Any] = {"allow_patterns": [prefix + n for n in ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")],
                          "token": os.environ.get("HF_TOKEN") or None}
    if revision:
        kw["revision"] = revision
    root = snapshot_download(repo, **kw)
    return os.path.join(root, sub) if sub else root


# ───────────────────────────────────────────── items ─────────────────────────────────────────────


def build_items(lt, tok, rows: list[dict], max_len: int, head_max_len: int) -> tuple[list[dict], dict]:
    """One Laya item per (row, question) with its label weight; `(items, stats)`.

    Uses the same functions `laya.train.items_from_rows` is made of, so a question is rendered exactly as inference sees
    it. `stats["truncated"]` counts items whose state did not fit the room left after the question head (those lose
    their tail inside `build_sequence`).
    """
    from laya.common import build_head

    items: list[dict] = []
    skipped: dict[str, int] = {}
    truncated = 0
    head_len: dict[str, int] = {}
    for rid, row in enumerate(rows):
        state_ids = lt.encode_state(tok, row["state"], max_len)
        for head in HEADS:
            gold = row["gold"].get(head)
            if gold is None:
                continue
            reason = None
            try:
                q = lt.to_internal(head, row["questions"][head])
                target = lt.target_from_gold(q, gold)
            except (ValueError, TypeError, KeyError):
                reason = "invalid"
            if reason is None:
                item, reason = lt.make_item(tok, q, target, state_ids, head_max_len)
            if reason is not None:
                skipped[reason] = skipped.get(reason, 0) + 1
                continue
            if head not in head_len:
                head_len[head] = len(build_head(tok, q, head_max_len)[0])
            if len(state_ids) > max_len - head_len[head] - 1:
                truncated += 1
            item.update({"rid": rid, "head": head, "w": float(row["weights"].get(head, 1.0)), "id": row["id"]})
            items.append(item)
    return items, {"items": len(items), "skipped": skipped, "truncated": truncated}


# ───────────────────────────────────────────── training ─────────────────────────────────────────────


def _forward(model, batch, device, amp: bool, detach_encoder: bool):
    import torch

    args = (batch["input_ids"].to(device), batch["attention_mask"].to(device), batch["marker_pos"].to(device),
            batch["marker_mask"].to(device), batch["qtype"].to(device))
    if amp:
        with torch.autocast(device.type, dtype=torch.float16):
            logits, _ = model(*args, detach_encoder=detach_encoder)
    else:
        logits, _ = model(*args, detach_encoder=detach_encoder)
    return logits.float()


def rlcd_row_loss(logits, target, mask, qtype, sigma: float, samples: int, w_sph: float, w_rps: float):
    """`laya.train.rlcd_loss` without the final mean: the loss of every row, shape [B]. Same maths, so
    `rlcd_row_loss(...).mean()` equals upstream's value for the same noise draw."""
    import torch
    from laya.common import proper_reward

    k = mask.sum(-1, keepdim=True).float()
    fmask = mask.float()
    eps = torch.randn((samples,) + logits.shape, device=logits.device) * sigma * fmask
    eps = (eps - eps.sum(-1, keepdim=True) / k) * fmask
    z = logits.detach().unsqueeze(0) + eps
    q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
    with torch.no_grad():
        r = proper_reward(q, target.unsqueeze(0), qtype, fmask, w_sph=w_sph, w_rps=w_rps)
        adv = r - r.mean(0, keepdim=True)
        adv = adv / (adv.std() + 1e-6)
    logp = -(((z - logits.unsqueeze(0)) ** 2) * fmask).sum(-1) / (2 * sigma**2)
    rl = -(adv * logp).mean(0)
    ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1) * mask).sum(-1)
    return rl + ce


def soft_ce_row_loss(logits, target, mask):
    import torch

    return -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1) * mask).sum(-1)


def train_weighted(lt, model, tok, items: list[dict], config, device, max_len: int, head_max_len: int,
                   max_steps: Optional[int] = None, on_epoch_end=None, log=print) -> list[float]:
    """Mirror of `laya.train.train_model` (same optimiser groups, cosine schedule, fp16 autocast, grad checkpointing,
    sigma annealing, option shuffling, grad accumulation and clip) with per-row loss weights `item["w"]`.

    The weighted loss of a micro-batch is `sum(w_i * loss_i) / sum(w_i)`: a batch of L0 rows is not down-scaled as a whole
    (AdamW would undo that anyway), only L0 rows are down-weighted against L1/L2 rows in the same batch.
    `max_steps` stops after that many optimizer updates (smoke tests). Returns the mean loss of each epoch.
    """
    import torch
    from laya.common import collate_items

    config.validate()
    if not items:
        raise ValueError("no training items")
    amp = (device.type == "cuda") if config.amp is None else bool(config.amp)
    checkpointing = amp if config.gradient_checkpointing is None else bool(config.gradient_checkpointing)
    if config.freeze_encoder:
        for p in model.encoder.parameters():
            p.requires_grad_(False)
    elif checkpointing and hasattr(model.encoder, "gradient_checkpointing_enable"):
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = checkpointing
    model.to(device).train()
    if config.freeze_encoder:
        model.encoder.eval()

    groups = [{"params": [p for n, p in model.named_parameters() if not n.startswith("encoder.") and p.requires_grad],
               "lr": config.head_lr}]
    if not config.freeze_encoder:
        groups.insert(0, {"params": [p for n, p in model.named_parameters() if n.startswith("encoder.") and p.requires_grad],
                          "lr": config.encoder_lr})
    optimizer = torch.optim.AdamW(groups, weight_decay=config.weight_decay)
    steps_per_epoch = math.ceil(len(items) / config.micro_batch)
    updates = max(1, math.ceil(steps_per_epoch / config.grad_accum) * config.epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=updates, eta_min=config.min_lr)
    scaler = torch.amp.GradScaler("cuda") if amp and device.type == "cuda" else None

    torch.manual_seed(config.seed)
    order_rng = random.Random(config.seed)
    params = [p for g in groups for p in g["params"]]
    history: list[float] = []
    done_updates = 0
    for epoch in range(config.epochs):
        epoch_items = list(items)
        random.Random(config.seed + epoch).shuffle(epoch_items)
        sigma = lt.sigma_at(epoch, config.epochs, config.sigma_start, config.sigma_end)
        total, n_steps = 0.0, 0
        optimizer.zero_grad(set_to_none=True)
        stop = False
        for start in range(0, len(epoch_items), config.micro_batch):
            chunk_items = epoch_items[start : start + config.micro_batch]
            chunk = [lt.encode_item(tok, it, max_len, head_max_len, lt.draw_option_order(it, order_rng, config.shuffle_options))
                     for it in chunk_items]
            batch = collate_items([chunk], tok.pad_token_id)
            logits = _forward(model, batch, device, amp, config.freeze_encoder)
            mask = batch["marker_mask"].to(device)
            target = batch["target"].to(device)
            if config.loss == "rlcd":
                row_loss = rlcd_row_loss(logits, target, mask, batch["qtype"].to(device), sigma, config.rl_samples,
                                         config.w_sph, config.w_rps)
            else:
                row_loss = soft_ce_row_loss(logits, target, mask)
            w = torch.tensor([it["w"] for it in chunk_items], dtype=row_loss.dtype, device=device)
            loss = (w * row_loss).sum() / w.sum().clamp_min(1e-6)
            scaled = loss / config.grad_accum
            if scaler is not None:
                scaler.scale(scaled).backward()
            else:
                scaled.backward()
            n_steps += 1
            if n_steps % config.grad_accum == 0 or start + config.micro_batch >= len(epoch_items):
                if scaler is not None:
                    scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(params, config.grad_clip)
                if scaler is not None:
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
                done_updates += 1
                if max_steps is not None and done_updates >= max_steps:
                    stop = True
            total += loss.item()
            if config.log_every and n_steps % config.log_every == 0:
                log("epoch %d/%d step %d loss %.4f" % (epoch + 1, config.epochs, n_steps, loss.item()))
            if stop:
                break
        mean = total / max(1, n_steps)
        history.append(mean)
        log("epoch %d/%d mean loss %.4f" % (epoch + 1, config.epochs, mean))
        if on_epoch_end is not None:
            on_epoch_end(epoch, mean)
        if stop:
            break
    model.eval()
    return history


# ───────────────────────────────────────────── prediction ─────────────────────────────────────────────


def temperature_for(qtype: int, k: int, temperature: list[float], by_options: dict) -> float:
    from laya.common import temp_bucket

    return float(by_options.get(temp_bucket(qtype, k), temperature[qtype]))


def predict_rows(lt, model, tok, rows: list[dict], device, max_len: int, head_max_len: int, temperature: list[float],
                 by_options: dict, batch_size: int = 16) -> list[dict]:
    """Prediction rows (logits + calibrated probs per head, no prompt text) for export rows. Rows missing a head are dropped."""
    items, _ = build_items(lt, tok, rows, max_len, head_max_len)
    recs = lt.calibration_records(model, tok, items, device, max_len, head_max_len, batch_size)
    per_row: dict[int, dict] = {}
    for it, (qtype, logits, _target, k) in zip(items, recs):
        p = softmax(np.asarray(logits[:k], dtype=np.float64), temperature_for(qtype, k, temperature, by_options))
        slot = per_row.setdefault(it["rid"], {"logits": {}, "probs": {}})
        slot["logits"][it["head"]] = [float(x) for x in logits[:k]]
        slot["probs"][it["head"]] = [float(x) for x in p]
    out = []
    for rid, row in enumerate(rows):
        slot = per_row.get(rid)
        if slot is None or any(h not in slot["probs"] for h in HEADS if h in row["gold"]):
            continue
        out.append({"id": row["id"], "split": row["meta"]["split"], "logits": slot["logits"], "probs": slot["probs"],
                    "meta": row["meta"]})
    return out


def write_preds(path: Path, preds: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for p in preds:
            f.write(json.dumps(to_jsonable(p), ensure_ascii=False) + "\n")


# ───────────────────────────────────────────── run ─────────────────────────────────────────────


def run(data_dir: Path, out_dir: Path, checkpoint: str = "multilingual", epochs: int = 6, micro_batch: int = 8,
        grad_accum: int = 8, encoder_lr: float = 2.5e-5, head_lr: float = 1e-4, loss: str = "rlcd",
        shuffle_options: bool = True, device: str = "auto", max_len: Optional[int] = None,
        head_max_len: Optional[int] = None, max_steps: Optional[int] = None, laya_loop: bool = False,
        target_error: float = 0.10, min_abstain_n: int = 30, seed: int = 0, revision: Optional[str] = None,
        no_amp: bool = False, no_grad_ckpt: bool = False, checkpoint_dir: Optional[str] = None, log=print) -> dict:
    lt, lt_source = load_train()
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = {s: read_jsonl(data_dir / ("%s.jsonl" % s)) for s in SPLITS if (data_dir / ("%s.jsonl" % s)).exists()}
    for need in ("train", "calibration", "test"):
        if not rows.get(need):
            raise SystemExit("teacher: %s.jsonl is missing or empty in %s (run export first)" % (need, data_dir))

    ckpt = checkpoint_dir or fetch_checkpoint(checkpoint, revision)
    dev = lt.resolve_device(device)
    model, tok, cfg = lt.load_checkpoint(ckpt)
    max_len = max_len or cfg.get("max_len", 512)
    head_max_len = head_max_len or cfg.get("head_max_len", 192)
    log("teacher: checkpoint %s (%s), laya.train from %s, device %s, max_len %d / head %d"
        % (checkpoint, ckpt, lt_source, dev, max_len, head_max_len))

    train_items, train_stats = build_items(lt, tok, rows["train"], max_len, head_max_len)
    cal_items, cal_stats = build_items(lt, tok, rows["calibration"], max_len, head_max_len)
    log("teacher: train items %s, calibration items %s" % (train_stats, cal_stats))
    if not train_items:
        raise SystemExit("teacher: no training items (every question was skipped: %s)" % train_stats["skipped"])

    config = lt.TrainConfig(epochs=epochs, micro_batch=micro_batch, grad_accum=grad_accum, encoder_lr=encoder_lr,
                            head_lr=head_lr, loss=loss, shuffle_options=("choice",) if shuffle_options else (),
                            calib_frac=0.0, seed=seed, max_len=max_len, head_max_len=head_max_len,
                            amp=False if no_amp else None, gradient_checkpointing=False if no_grad_ckpt else None)
    ckpt_latest = out_dir / "model_latest"

    def on_epoch(epoch: int, mean: float) -> None:
        lt.save_checkpoint(model, tok, dict(cfg, max_len=max_len, head_max_len=head_max_len), str(ckpt_latest))

    t0 = time.time()
    if laya_loop:
        log("teacher: upstream laya.train.train_model (unweighted)")
        history = lt.train_model(model, tok, train_items, config, dev, max_len, head_max_len, on_epoch_end=on_epoch)
    else:
        history = train_weighted(lt, model, tok, train_items, config, dev, max_len, head_max_len, max_steps, on_epoch, log)
    train_seconds = time.time() - t0

    # Calibration: fitted on the calibration split only, with the library's fitter and the runtime's clamp.
    from laya.calibrate import fit_abstention_thresholds, fit_temperature_map

    cal_records = lt.calibration_records(model, tok, cal_items, dev, max_len, head_max_len)
    fitted = fit_temperature_map(cal_records)
    temperature, by_options = fitted["temperature"], fitted["temperature_by_options"]
    abstain = fit_abstention_thresholds(cal_records, temperature, by_options, target_error=target_error,
                                        min_bucket_n=min_abstain_n)
    log("teacher: temperature %s, bucket map %s, abstention %s" % (temperature, by_options, abstain))

    out_cfg = dict(cfg, max_len=max_len, head_max_len=head_max_len, fine_tuned=True, model_name="agento-teacher",
                   temperature=temperature)
    out_cfg.pop("temperature_by_options", None)  # an inherited bucket map would mask the new fit (docs/finetune.md)
    if by_options:
        out_cfg["temperature_by_options"] = by_options
    out_cfg["training"] = dict(out_cfg.get("training") or {}, agento={"epochs": epochs, "loss": loss, "weighted": not laya_loop,
                                                                       "laya_train": lt_source, "base": checkpoint})
    model_dir = out_dir / "model"
    lt.save_checkpoint(model, tok, out_cfg, str(model_dir))

    # Predictions on every split, with the calibrated temperatures.
    preds: dict[str, list[dict]] = {}
    for split, rs in rows.items():
        preds[split] = predict_rows(lt, model, tok, rs, dev, max_len, head_max_len, temperature, by_options)
        write_preds(out_dir / ("preds_%s.jsonl" % split), preds[split])

    tier_fit = thresholds_from_calibration(preds["calibration"])
    thr = effective_threshold(tier_fit)
    metrics: dict[str, Any] = {
        "kind": "teacher",
        "checkpoint": checkpoint,
        "laya_train": lt_source,
        "loop": "laya.train.train_model" if laya_loop else "weighted mirror of laya.train.train_model",
        "device": str(dev),
        "max_len": max_len,
        "train": {"epochs": epochs, "loss_per_epoch": history, "seconds": train_seconds, **train_stats,
                  "weights": "unweighted" if laya_loop else "L2 1.0 / L1 0.6 / L0 0.3 (x0.5 for derived binary heads)"},
        "calibration": {"items": cal_stats, "temperature": temperature, "temperature_by_options": by_options,
                        "n_by_bucket": fitted["n_by_bucket"], "abstention_thresholds": abstain,
                        "abstention_target_error": target_error, "tier_threshold": tier_fit},
        "eval": {},
        "baselines": {},
        "per_project": {},
    }
    for split in ("test", "holdout"):
        if preds.get(split):
            metrics["eval"][split] = evaluate_rows(preds[split], thr)
            metrics["baselines"][split] = evaluate_baselines(preds[split], rows["train"])
            metrics["per_project"][split] = per_project(preds[split], thr)
    metrics["eval"]["calibration"] = evaluate_rows(preds["calibration"], thr)
    metrics["eval"]["train_in_sample"] = evaluate_rows(preds["train"], thr)
    metrics["laya_runtime_check"] = check_laya_runtime(model_dir, rows["test"][:3], preds["test"][:3], log)

    with open(out_dir / "calibration.json", "w", encoding="utf-8") as f:
        json.dump(to_jsonable(metrics["calibration"]), f, indent=2)
    with open(out_dir / "metrics.json", "w", encoding="utf-8") as f:
        json.dump(to_jsonable(metrics), f, indent=2)
    log("teacher: done in %.0fs; tier acc on test %.3f" % (train_seconds, metrics["eval"]["test"]["heads"]["tier"]["accuracy"]))
    return metrics


def check_laya_runtime(model_dir: Path, rows: list[dict], preds: list[dict], log=print) -> dict:
    """Load the saved checkpoint with `laya.load` (what `laya-serve` / `/v1/systemone` does) and compare its answers.

    Confirms the checkpoint is a valid Laya checkpoint with the temperatures installed. A difference is expected to be small
    (weights are stored in fp16, the loader may sort options); a large one means the calibration was not what Laya serves.
    """
    try:
        import laya

        agent = laya.load(str(model_dir), device="cpu")
        worst = 0.0
        for row, pred in zip(rows, preds):
            ans = agent.predict(row["state"], row["questions"])["answers"]
            probs = ans["tier"]["probabilities"]
            ours = pred["probs"]["tier"]
            from .questions import TIERS

            worst = max(worst, max(abs(float(probs[t]) - ours[i]) for i, t in enumerate(TIERS)))
        log("teacher: laya.load check ok, max |p_laya - p_ours| on tier = %.4f over %d rows" % (worst, len(rows)))
        return {"ok": True, "rows": len(rows), "max_tier_prob_diff": worst}
    except Exception as e:  # noqa: BLE001 - reported, not fatal: the run's own metrics stand
        log("teacher: laya.load check FAILED: %s: %s" % (type(e).__name__, e))
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def add_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--checkpoint", default="multilingual", help="multilingual (default) | english | typed-decisions | local dir")
    ap.add_argument("--revision", default=None, help="HF revision of the Laya repo")
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--micro-batch", type=int, default=8)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--encoder-lr", type=float, default=2.5e-5)
    ap.add_argument("--head-lr", type=float, default=1e-4)
    ap.add_argument("--loss", choices=["rlcd", "soft-ce"], default="rlcd")
    ap.add_argument("--no-shuffle-options", action="store_true", help="do not randomise the tier option order each epoch")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--max-len", type=int, default=None)
    ap.add_argument("--head-max-len", type=int, default=None)
    ap.add_argument("--max-steps", type=int, default=None, help="stop after N optimizer updates (smoke)")
    ap.add_argument("--laya-loop", action="store_true", help="run upstream laya.train.train_model unchanged (no per-record weights)")
    ap.add_argument("--target-error", type=float, default=0.10, help="error target of laya's fit_abstention_thresholds")
    ap.add_argument("--min-abstain-n", type=int, default=30)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-amp", action="store_true")
    ap.add_argument("--no-grad-ckpt", action="store_true", help="48 GB can afford it: faster, more memory")


def run_from_args(a: argparse.Namespace, data_dir: Path, out_dir: Path, checkpoint_dir: Optional[str] = None, log=print) -> dict:
    return run(data_dir, out_dir, a.checkpoint, a.epochs, a.micro_batch, a.grad_accum, a.encoder_lr, a.head_lr, a.loss,
               not a.no_shuffle_options, a.device, a.max_len, a.head_max_len, a.max_steps, a.laya_loop, a.target_error,
               a.min_abstain_n, a.seed, a.revision, a.no_amp, a.no_grad_ckpt, checkpoint_dir, log)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="export directory (train/calibration/test.jsonl)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--checkpoint-dir", default=None, help="use this local Laya checkpoint directory instead of downloading")
    add_args(ap)
    a = ap.parse_args(argv)
    run_from_args(a, Path(a.data), Path(a.out), a.checkpoint_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
