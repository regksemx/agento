"""One command: export -> teacher -> distill -> report, artifacts under `artifacts/<run-id>/`.

    python -m agento_train.pipeline --tasks ~/.agento/dataset/tasks.jsonl            # the real run (GPU box)
    python -m agento_train.pipeline --smoke                                           # 2 steps on CPU, tiny models, synthetic data

`--smoke` proves the wiring end to end without a GPU or big downloads: synthetic tasks, a tiny random ModernBERT as both the
Laya "checkpoint" and the student. Its numbers mean nothing; its job is to fail loudly if any stage cannot hand over to the next.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

from . import distill, export, report, teacher
from .smoke import TINY_ENCODER, make_tiny_checkpoint, write_synthetic_tasks


def default_run_id() -> str:
    return dt.datetime.now().strftime("run-%Y%m%d-%H%M%S")


def run(a: argparse.Namespace, log=print) -> Path:
    run_id = a.run_id or default_run_id()
    root = Path(a.out_root) / run_id
    root.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    log("pipeline: run %s -> %s" % (run_id, root))

    if a.smoke:
        tasks = write_synthetic_tasks(root / "smoke_input" / "tasks.jsonl")
        judge_dir: Optional[Path] = tasks.parent / "judge"
        ckpt_dir = str(make_tiny_checkpoint(root / "smoke_input" / "tiny_laya"))
        a.device, a.epochs, a.micro_batch, a.grad_accum, a.max_steps = "cpu", 1, 2, 1, 2
        a.min_abstain_n = 5
        a.student, a.student_epochs, a.student_batch, a.student_max_len = TINY_ENCODER, 1, 8, 64
        a.student_device, a.student_max_steps, a.latency_runs = "cpu", 2, 5
    else:
        tasks = Path(a.tasks).expanduser()
        judge_dir = Path(a.judge_dir).expanduser() if a.judge_dir else tasks.parent / "judge"
        ckpt_dir = None

    # The teacher's checkpoint first: its tokenizer gives export exact token budgets.
    ckpt = ckpt_dir or teacher.fetch_checkpoint(a.checkpoint, a.revision)
    tokenizer = None
    if (Path(ckpt) / "tokenizer").is_dir():
        from laya.agent import _fix_tokenizer_config

        _fix_tokenizer_config(ckpt)
        tokenizer = str(Path(ckpt) / "tokenizer")

    data_dir = root / "data"
    log("pipeline: [1/4] export")
    stats = export.export(tasks, data_dir, judge_dir, tokenizer, a.max_state_tokens, a.holdout_project, False)

    log("pipeline: [2/4] teacher")
    teacher.run_from_args(a, data_dir, root / "teacher", ckpt, log)

    log("pipeline: [3/4] student")
    distill.run_from_args(a, data_dir, root / "teacher", root / "student", run_id, log)

    log("pipeline: [4/4] report")
    report.write_report(root, run_id, stats, log)
    (root / "run.json").write_text(json.dumps({"run_id": run_id, "seconds": time.time() - t0, "smoke": bool(a.smoke),
                                               "argv": sys.argv[1:]}, indent=2))
    log("pipeline: done in %.0fs; report: %s" % (time.time() - t0, root / "report.md"))
    return root


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tasks", default=export.DEFAULT_TASKS)
    ap.add_argument("--judge-dir", default=None)
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--out-root", default="artifacts")
    ap.add_argument("--smoke", action="store_true", help="2 steps on CPU with tiny models and synthetic data")
    ap.add_argument("--max-state-tokens", type=int, default=export.MAX_STATE_TOKENS)
    ap.add_argument("--holdout-project", action="append", default=[], metavar="SUBSTR")
    teacher.add_args(ap)
    distill.add_args(ap)
    a = ap.parse_args(argv)
    run(a)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)  # see distill.main: avoids a macOS teardown abort after a successful run


if __name__ == "__main__":
    sys.exit(main())
