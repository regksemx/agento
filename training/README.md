# agento training (phase 2: T33, T34, T35)

Turns the owner's `tasks.jsonl` into a router: a **Laya teacher** (RLCD, calibrated) and a small **ONNX student** that the
daemon (`brain/`) serves. Dataset: `docs/dataset-schema.md`; artifact contract:
`brain/CONTRACT.md`.

```
tasks.jsonl (+ judge/*.jsonl)
   │ export.py     time split, labels L2 > L1 > L0 with weights, Laya rows + distill.jsonl
   ▼
Laya teacher       teacher.py   RLCD fine-tune, temperature + abstention fitted on the calibration split, metrics on test
   ▼
student (ONNX)     distill.py   KD + labels, multi-head, fp32 ONNX (opset 17) + parity, optional static INT8, CPU latency
   ▼
report.md + metrics.json        report.py
```

## Run it on the GPU box (48 GB)

From your Mac, one command (syncs `training/`, `brain/` and only `tasks.jsonl` + `judge/*.jsonl`, never raw transcripts):

```bash
AGENTO_GPU_HOST=gpu-box AGENTO_GPU_DIR=/data/agento scripts/train-remote.sh
scripts/train-remote.sh --status          # tail the log
scripts/train-remote.sh --pull            # fetch the latest run (report, metrics, student/model; not data/, not teacher weights)
```

Or directly on the box, from a checkout of `training/`:

```bash
AGENTO_TASKS=~/.agento/dataset/tasks.jsonl training/run.sh
```

`run.sh` creates `training/.venv` (uv if present, else venv + pip), installs `.[train]`, and runs
`python -m agento_train.pipeline`. Everything lands in `training/artifacts/<run-id>/` (git-ignored):

| path | what |
|---|---|
| `report.md`, `metrics.json` | the numbers (no prompt text) |
| `student/model/` | **the daemon artifact**: `model.onnx`, `tokenizer.json`, `heads.json`, `meta.json`; check with `agento-brain check <dir>` |
| `student/student.fp32.onnx`, `student.int8.onnx` | the INT8 file exists only if it passed the gate |
| `teacher/model/` | a Laya checkpoint (`laya.load`-able, temperatures in `rl_agent_config.json`) |
| `teacher/preds_*.jsonl`, `student/preds_*.jsonl` | calibrated probabilities per task id (no text) |
| `data/` | the export (**contains scrubbed prompt text**: stays on the box) |
| `run.log`, `gpu.txt` | log |

Useful flags (all go through `run.sh`): `--checkpoint multilingual|english|typed-decisions|<dir>` (default multilingual:
the prompts are mostly Russian), `--epochs 6`, `--student intfloat/multilingual-e5-small` (default; falls back to
`jhu-clsp/mmBERT-small` if it cannot load; `--student jhu-clsp/ettin-encoder-150m --student-max-len 512` restores the old 150m, see
`BENCHMARK.md`), `--student-max-len 256`, `--no-shrink-embeddings`, `--holdout-project <substr>` (repeatable), `--no-int8`,
`--laya-loop` (upstream's unweighted loop for an A/B), `--no-grad-ckpt` (faster, more memory; 48 GB can afford it),
`--micro-batch/--grad-accum`. `TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124` picks a CUDA build.

Laptop check, no GPU, no big downloads (tiny random models, synthetic tasks, 2 steps): `training/run.sh --smoke`.

## What each stage does

**Export (T33).** Input text is rendered with the daemon's template (`textin.py` is a port of
`brain/src/agento_brain/textin.py`; `tests/test_textin.py` compares them): header line(s) with `lang`, `repo`, `ctx`, `start`,
`prev_task`, `mentions` + the **first prompt only** (follow-ups did not exist when the router must decide). `files_in_repo` and
`git_dirty` are not in `tasks.jsonl` v1: they render as `unknown` / `0`. `startKind` maps to `session` / `clear` (also compact) /
`cold`. For the teacher the prompt is cut head/tail so header + prompt fit 840 tokens (exact with `--tokenizer`, which
`run.sh` supplies from the Laya checkpoint); the student sees the full prompt and truncates at token level (first 75%, last 25%).
Questions (spec section 4): `tier` choice haiku/sonnet/opus, `effort` score low/medium/high, `plan_first` noul,
`delegate_explore` noul.

Labels per head: L2 (`l2Tier`/`l2Effort` or `l2: {...}`) > L1 (`l1Tier`/`l1Effort`/`l1Probs` or `l1: {...}`, soft targets from
`l1Probs`) > L0 (`l0Tier`/`l0Effort`), weights 1.0 / 0.6 / 0.3. Judge output in `judge/*.jsonl` (one JSON per line, keyed by
`taskId`, same field names) is merged first. `l1Probs` may be `{"tier": {"haiku":..}, "effort": {...}}` or flat
`{"haiku":.., "sonnet":.., "opus":..}`. **These field shapes are an assumption**: the schema doc does not define them yet;
adjust `_source_view` / `_label_from_view` in `export.py` if the judge writes something else. `plan_first` and
`delegate_explore` have no L0 label of their own: derived from `observed.planMode` (or Opus with >= 6 files edited) and from an
Explore/scout subagent in the task, weight x0.5, until a judge supplies them.

Split by time: last 15% by `startTs` test, the 15% before it calibration, rest train; `--holdout-project` keeps whole projects
out of all three (reported as the `holdout` split, plus a per-project table on test).

**Teacher (T35a).** Laya's training loop is `laya.train` (RLCD: policy gradient over noisy logits with proper-scoring-rule
reward + soft cross-entropy; encoder lr 2.5e-5, head lr 1e-4, cosine, fp16 autocast, grad checkpointing). It is in the Laya
repo but **not in the PyPI wheel 0.3.27**, so `pyproject.toml` pins the git revision, and `_laya_port.py` is a vendored copy used
when the module is missing. The building blocks (question/target/item construction, option shuffling, loss, checkpoint IO,
calibration records) come from there; `teacher.train_weighted` mirrors `train_model` and adds per-record loss weights, which
upstream lacks (`--laya-loop` runs upstream's unchanged). Temperatures: `laya.calibrate.fit_temperature_map` on the calibration
split only; `fit_abstention_thresholds` on the same records; agento's tier threshold is the smallest confidence whose accepted
set has a Clopper-Pearson upper bound of under-routing <= 5% at 95% (spec section 6). Note: a 5% bound needs >= 59 accepted
tasks without a single error, so a small calibration split often yields "no safe threshold", which is the honest answer.

**Student (T35b).** Encoder + mean pooling + one trunk + four heads. Loss per head: `alpha*KD(calibrated teacher) +
(1-alpha)*weight*CE(labels)`. ONNX fp32 opset 17, inputs `input_ids`/`attention_mask`, outputs `logits_<head>`; ORT vs torch
argmax agreement must be >= 99% (the run fails otherwise). Static INT8 (QDQ, calibrated on training texts) is kept only if
agreement with fp32 >= 98% and mean ECE delta <= 0.02, else deleted with the reason printed. Dynamic INT8 is never produced
(Laya measured it collapsing agreement). Latency: onnxruntime CPU, batch 1, `max_len` tokens (256) and a 128-token prompt, p50/p95. The word-embedding table is stored as fp16 in
the ONNX (fp32 compute, -190 MB for multilingual vocabularies; `--no-shrink-embeddings` to disable). The student default
(`multilingual-e5-small`, max_len 256: p50 ~35 ms, 279 MB on an M-series Mac) comes from the study in `BENCHMARK.md`.

**Metrics.** Accuracy, macro-F1, ECE, Brier, AURC per head; under-routing (recommended cheaper than the label), over-routing, and
savings, against always-opus, always-sonnet, rules v1 (`rulesVerdict`), L0, majority. Savings formula
(`metrics.py`): `C' = C * (1 - s * (1 - r))`, `r = price_out[recommended] / price_out[observed]` (opus -> sonnet 0.5, opus -> haiku
0.25, fable -> opus 0.4), `s = 1` list price, `s = 0.5` conservative (cache reads cost the same on Opus and Sonnet);
below-threshold recommendations are not applied; "net of re-runs" charges under-routed tasks one extra run.

## Tests (no GPU)

```bash
cd training && uv venv && uv pip install -e ".[train,dev]" && uv pip install -e ../brain
.venv/bin/python -m pytest -q          # export, metrics, textin, and the end-to-end smoke (tiny models from the HF hub)
```

## Known limits

- The first dataset has ~600 tasks, almost all L0: the numbers measure agreement with a weak labeler, and only 7 train tasks are haiku.
- Teacher probabilities on train rows are in-sample (near the labels); KD helps most with extra unlabeled prompts, which this pipeline does not add yet.
- The Laya multilingual checkpoint has a position bias on `score` questions (Laya issue #131): effort may need the `english` checkpoint or a different head.
- Calibration is fitted on whatever labels the calibration split has; with L0-only labels it calibrates to L0.
- Weights trained on this data are private; never publish them.

`_laya_port.py` is a copy of `laya/train.py` from github.com/NandhaKishorM/laya (Apache-2.0).
