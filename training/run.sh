#!/usr/bin/env bash
# One command on the GPU box: venv -> install -> export -> teacher (Laya RLCD) -> student distillation -> report.
#
#   training/run.sh                       # all stages on $AGENTO_TASKS (default ~/.agento/dataset/tasks.jsonl)
#   training/run.sh --smoke               # 2 steps on CPU, tiny models, synthetic data (proves the wiring)
#   training/run.sh --epochs 8 --checkpoint english --holdout-project myapp     # any flag of agento_train.pipeline
#   training/run.sh --student jhu-clsp/ettin-encoder-150m --student-max-len 512  # the old, slower 150m student (see BENCHMARK.md)
#   Student defaults (agento_train.distill): intfloat/multilingual-e5-small, --student-max-len 256.
#
# Environment: AGENTO_TASKS, AGENTO_RUN_ID, TORCH_INDEX_URL (e.g. https://download.pytorch.org/whl/cu124),
#              LAYA_FROM_PYPI=1 (skip the pinned git revision of laya; the vendored loop is used), HF_TOKEN, PYTHON.
# Artifacts: training/artifacts/<run-id>/ (report.md, metrics.json, teacher/, student/model/ ...), log in run.log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

RUN_ID="${AGENTO_RUN_ID:-run-$(date +%Y%m%d-%H%M%S)}"
TASKS="${AGENTO_TASKS:-$HOME/.agento/dataset/tasks.jsonl}"
SMOKE=0
for a in "$@"; do [ "$a" = "--smoke" ] && SMOKE=1; done

if [ "$SMOKE" = 0 ] && [ ! -f "$TASKS" ]; then
  echo "run.sh: dataset not found: $TASKS (set AGENTO_TASKS, or run 'agento dataset build')" >&2
  exit 2
fi

PY="${PYTHON:-python3}"
if command -v uv >/dev/null 2>&1; then
  [ -d .venv ] || uv venv --python 3.11 .venv >/dev/null 2>&1 || uv venv .venv
  PIP=(uv pip install --python .venv/bin/python)
else
  [ -d .venv ] || "$PY" -m venv .venv
  PIP=(.venv/bin/python -m pip install -q)
fi
EXTRA=()
[ -n "${TORCH_INDEX_URL:-}" ] && EXTRA=(--extra-index-url "$TORCH_INDEX_URL")

echo "run.sh: installing into $HERE/.venv"
if [ "${LAYA_FROM_PYPI:-0}" = 1 ]; then
  "${PIP[@]}" ${EXTRA[@]+"${EXTRA[@]}"} -e . torch transformers safetensors huggingface_hub tokenizers "laya>=0.3.27" onnx onnxruntime onnxscript
elif ! "${PIP[@]}" ${EXTRA[@]+"${EXTRA[@]}"} -e ".[train]"; then
  echo "run.sh: could not install laya from git; retry with LAYA_FROM_PYPI=1 (uses the vendored training loop)" >&2
  exit 3
fi
# The daemon's own contract check runs on the student artifact when brain/ was synced along.
[ -d ../brain ] && "${PIP[@]}" -e ../brain >/dev/null || true

mkdir -p "artifacts/$RUN_ID"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | tee "artifacts/$RUN_ID/gpu.txt" || echo "run.sh: no GPU visible (nvidia-smi missing)"

echo "run.sh: run $RUN_ID, dataset $TASKS"
.venv/bin/python -m agento_train.pipeline --tasks "$TASKS" --run-id "$RUN_ID" --out-root artifacts "$@" 2>&1 | tee "artifacts/$RUN_ID/run.log"
STATUS=${PIPESTATUS[0]}
if [ "$STATUS" -ne 0 ]; then echo "run.sh: pipeline failed (exit $STATUS), see artifacts/$RUN_ID/run.log" >&2; exit "$STATUS"; fi
echo "run.sh: done. Report: $HERE/artifacts/$RUN_ID/report.md"
