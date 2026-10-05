#!/usr/bin/env bash
# T34: train on the owner's GPU box. Syncs training/ (and brain/, for the contract check) plus ONLY the scrubbed dataset
# (tasks.jsonl and judge/*.jsonl, never raw transcripts) to $AGENTO_GPU_HOST:$AGENTO_GPU_DIR, runs training/run.sh there
# detached (tmux, else nohup) with a log, and can pull the artifacts back.
#
#   AGENTO_GPU_HOST=gpu-box AGENTO_GPU_DIR=/data/agento scripts/train-remote.sh [run.sh args...]
#   scripts/train-remote.sh --status            # tail the log, say whether the run is still going
#   scripts/train-remote.sh --pull [RUN_ID]     # fetch artifacts/<run> (report, metrics, student/model); latest if omitted
#   scripts/train-remote.sh --pull RUN_ID --with-teacher   # also the (large) teacher checkpoint
#
# Environment: AGENTO_GPU_HOST (ssh host or user@host), AGENTO_GPU_DIR (remote working dir),
#   AGENTO_DATASET_DIR (local dataset dir, default ~/.agento/dataset), AGENTO_RUN_ID, AGENTO_SSH_OPTS, TORCH_INDEX_URL, HF_TOKEN.
# The dataset holds scrubbed prompt text: it goes to your own box only. `--pull` never fetches data/ (prompt text).
set -euo pipefail

die() { echo "train-remote: $*" >&2; exit 2; }
[ -n "${AGENTO_GPU_HOST:-}" ] || die "AGENTO_GPU_HOST is not set (ssh host of the GPU server, e.g. gpu-box or me@10.0.0.5)"
[ -n "${AGENTO_GPU_DIR:-}" ] || die "AGENTO_GPU_DIR is not set (remote directory to work in, e.g. /data/agento)"
case "$AGENTO_GPU_DIR" in /|"") die "AGENTO_GPU_DIR must not be / or empty";; esac
command -v rsync >/dev/null 2>&1 || die "rsync not found locally"
command -v ssh >/dev/null 2>&1 || die "ssh not found locally"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATASET_DIR="${AGENTO_DATASET_DIR:-$HOME/.agento/dataset}"
HOST="$AGENTO_GPU_HOST"
DIR="$AGENTO_GPU_DIR"
# shellcheck disable=SC2206
SSH_OPTS=(${AGENTO_SSH_OPTS:-})
SSH=(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$HOST")
RSYNC_SSH="ssh ${AGENTO_SSH_OPTS:-}"

latest_run() { "${SSH[@]}" "ls -1t '$DIR/training/artifacts' 2>/dev/null | head -1"; }

case "${1:-}" in
  --pull)
    shift
    RUN="${1:-}"; [ "${RUN:0:2}" = "--" ] && RUN=""
    [ -n "$RUN" ] && shift || true
    WITH_TEACHER=0; for a in "$@"; do [ "$a" = "--with-teacher" ] && WITH_TEACHER=1; done
    [ -n "$RUN" ] || RUN="$(latest_run)"
    [ -n "$RUN" ] || die "no runs found in $HOST:$DIR/training/artifacts"
    DEST="$REPO/training/artifacts/$RUN"
    mkdir -p "$DEST"
    # data/ holds prompt text and smoke_input/ synthetic data: never pulled. Teacher weights only on request.
    EXCL=(--exclude 'data/' --exclude 'smoke_input/' --exclude 'model_latest/' --exclude '*.pt')
    [ "$WITH_TEACHER" = 1 ] || EXCL+=(--exclude 'teacher/model/')
    rsync -az -e "$RSYNC_SSH" "${EXCL[@]}" "$HOST:$DIR/training/artifacts/$RUN/" "$DEST/"
    echo "train-remote: pulled $RUN -> $DEST"
    [ -f "$DEST/report.md" ] && echo "train-remote: report: $DEST/report.md" || echo "train-remote: no report.md yet (run unfinished or failed; see $DEST/run.log)"
    exit 0 ;;
  --status)
    RUN="${2:-$(latest_run)}"
    [ -n "$RUN" ] || die "no runs found"
    "${SSH[@]}" "tail -n 25 '$DIR/training/artifacts/$RUN/run.log' 2>/dev/null || tail -n 25 '$DIR/logs/$RUN.log'; if tmux has-session -t 'agento-$RUN' 2>/dev/null || pgrep -f 'agento_train.pipeline.*$RUN' >/dev/null; then echo '[still running]'; else echo '[not running]'; fi"
    exit 0 ;;
esac

[ -f "$DATASET_DIR/tasks.jsonl" ] || die "dataset not found: $DATASET_DIR/tasks.jsonl (run 'agento dataset build', or set AGENTO_DATASET_DIR)"
RUN_ID="${AGENTO_RUN_ID:-run-$(date +%Y%m%d-%H%M%S)}"

echo "train-remote: syncing to $HOST:$DIR"
"${SSH[@]}" "mkdir -p '$DIR/training' '$DIR/dataset/judge' '$DIR/logs'"
# Code: training/ without artifacts or venv; brain/ is small and lets run.sh validate the student with `agento-brain check`.
rsync -az --delete -e "$RSYNC_SSH" --exclude 'artifacts/' --exclude '.venv/' --exclude '__pycache__/' --exclude '*.egg-info/' --exclude '.pytest_cache/' \
  "$REPO/training/" "$HOST:$DIR/training/"
if [ -d "$REPO/brain" ]; then
  rsync -az --delete -e "$RSYNC_SSH" --exclude '__pycache__/' --exclude '.venv/' --exclude '*.egg-info/' --exclude '.pytest_cache/' "$REPO/brain/" "$HOST:$DIR/brain/"
fi
# Data: only the scrubbed task file and judge output.
rsync -az -e "$RSYNC_SSH" "$DATASET_DIR/tasks.jsonl" "$HOST:$DIR/dataset/tasks.jsonl"
if compgen -G "$DATASET_DIR/judge/*.jsonl" >/dev/null; then
  rsync -az --delete -e "$RSYNC_SSH" --include '*.jsonl' --exclude '*' "$DATASET_DIR/judge/" "$HOST:$DIR/dataset/judge/"
fi
"${SSH[@]}" "chmod 600 '$DIR/dataset/tasks.jsonl'"

ARGS=""; for a in "$@"; do ARGS+=" $(printf '%q' "$a")"; done
ENVS="AGENTO_RUN_ID=$(printf '%q' "$RUN_ID") AGENTO_TASKS=$(printf '%q' "$DIR/dataset/tasks.jsonl")"
[ -n "${TORCH_INDEX_URL:-}" ] && ENVS+=" TORCH_INDEX_URL=$(printf '%q' "$TORCH_INDEX_URL")"
[ -n "${HF_TOKEN:-}" ] && ENVS+=" HF_TOKEN=$(printf '%q' "$HF_TOKEN")"
CMD="cd '$DIR/training' && $ENVS ./run.sh$ARGS"

# Detached: tmux when the box has it (attach with: ssh $HOST -t tmux attach -t agento-$RUN_ID), else nohup.
"${SSH[@]}" "if command -v tmux >/dev/null 2>&1; then tmux new-session -d -s 'agento-$RUN_ID' \"bash -lc \\\"$CMD > '$DIR/logs/$RUN_ID.log' 2>&1\\\"\"; else nohup bash -lc \"$CMD\" > '$DIR/logs/$RUN_ID.log' 2>&1 < /dev/null & fi"

cat <<MSG
train-remote: started run $RUN_ID on $HOST
  follow : $0 --status $RUN_ID        (or: ssh $HOST tail -f $DIR/logs/$RUN_ID.log)
  attach : ssh $HOST -t tmux attach -t agento-$RUN_ID     (if tmux is installed there)
  fetch  : $0 --pull $RUN_ID
MSG
