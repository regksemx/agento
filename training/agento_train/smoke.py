"""Synthetic data and a tiny checkpoint, to prove the pipeline wires end to end on a laptop (no GPU, no big downloads).

`synthetic_tasks` writes records in the `tasks.jsonl` v1 shape (docs/dataset-schema.md). `make_tiny_checkpoint` builds a
Laya-format checkpoint around `hf-internal-testing/tiny-random-ModernBertModel` (hidden size 32) so the real Laya code path
(`laya.common.build_model`, `build_sequence`, RLCD loss, calibration) runs for real, just on random weights.
"""
from __future__ import annotations

import json
import random
from pathlib import Path

TINY_ENCODER = "hf-internal-testing/tiny-random-ModernBertModel"
TINY_STUDENT = TINY_ENCODER  # the student smoke test uses the same tiny encoder

_LIGHT = ["Что делает функция {f}?", "Where is {f} defined?", "Объясни, как работает {f}", "Show me the type of {f}"]
_MID = ["Исправь баг в {f}: падает на пустом списке", "Add a --verbose flag to {f}", "Перепиши {f} на async",
        "Fix the failing test in {f}"]
_HEAVY = ["Спроектируй архитектуру миграции {f} на микросервисы и реализуй", "Refactor the whole {f} module, many files, "
          "keep the public API", "Найди гонку данных в {f} и почини без потери производительности"]
_FILES = ["src/app.ts", "cli/main.py", "core/task.kt", "lib/db.go", "README.md"]
_PROJECTS = ["~/Projects/alpha", "~/Projects/beta", "~/IdeaProjects/gamma", "~/PycharmProjects/delta"]


def synthetic_tasks(n: int = 120, seed: int = 7, start_ts: int = 1_790_000_000_000) -> list[dict]:
    """`n` tasks in time order. Prompt style correlates with the label so a model can learn something."""
    rng = random.Random(seed)
    out = []
    for i in range(n):
        kind = rng.choices(["light", "mid", "heavy"], weights=[2, 4, 4])[0]
        f = rng.choice(_FILES)
        prompt = rng.choice({"light": _LIGHT, "mid": _MID, "heavy": _HEAVY}[kind]).format(f=f)
        tier = {"light": "haiku", "mid": "sonnet", "heavy": "opus"}[kind]
        effort = {"light": "low", "mid": rng.choice(["low", "medium", "high"]), "heavy": "high"}[kind]
        obs_tier = rng.choices(["opus", "sonnet", "fable"], weights=[8, 1, 1])[0]
        out_tokens = rng.randint(500, 60_000)
        cost = round(out_tokens / 1e6 * {"opus": 20, "sonnet": 10, "fable": 50}[obs_tier] * rng.uniform(3, 8), 4)
        kinds = ["first-prompt", "clear", "idle", "compact"]
        rec = {
            "v": 1,
            "taskId": "%016x" % rng.getrandbits(64),
            "project": rng.choice(_PROJECTS),
            "startTs": start_ts + i * 3_600_000 + rng.randint(0, 600_000),
            "text": [prompt, "и ещё тесты " + f, "нет, не так"][: rng.randint(1, 3)],
            "context": {
                "contextTokensAtStart": rng.randint(0, 150_000),
                "startKind": rng.choice(kinds),
                "languages": rng.sample(["typescript", "python", "kotlin", "go"], rng.randint(0, 2)),
                "hasGitBranch": rng.random() < 0.8,
                "prevTaskWasHeavy": rng.random() < 0.4,
            },
            "observed": {
                "model": "claude-" + obs_tier, "modelTier": obs_tier, "effort": "high",
                "mainCalls": rng.randint(1, 80), "subagentCalls": rng.randint(0, 3),
                "subagentTypes": rng.choice([[], [], ["Explore"], ["general-purpose"]]),
                "filesEdited": rng.randint(0, 9), "linesChanged": rng.randint(0, 500), "toolErrors": rng.randint(0, 4),
                "testRuns": 0, "testFailures": 0, "sameEditRepeats": 0, "userCorrections": rng.randint(0, 2),
                "userInterrupts": 0, "planMode": kind == "heavy" and rng.random() < 0.3,
                "durationMs": rng.randint(10_000, 4_000_000), "outputTokens": out_tokens, "cost": cost,
            },
            "difficulty": 0.5,
            "l0Tier": tier,
            "l0Effort": effort,
            "rulesVerdict": {"tier": rng.choice(["sonnet", "sonnet", "opus", "haiku"]), "effort": rng.choice(["medium", "high"]),
                             "confidence": 0.4, "reasons": ["synthetic"]},
            "labelSource": "L0",
        }
        out.append(rec)
    return out


def write_synthetic_tasks(path: Path, n: int = 120, seed: int = 7, judge_share: float = 0.2) -> Path:
    """Write tasks.jsonl, and a `judge/l1.jsonl` next to it for a share of the tasks (exercises label precedence)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    recs = synthetic_tasks(n, seed)
    with open(path, "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    rng = random.Random(seed + 1)
    judge_dir = path.parent / "judge"
    judge_dir.mkdir(exist_ok=True)
    with open(judge_dir / "l1.jsonl", "w", encoding="utf-8") as f:
        for r in recs:
            if rng.random() < judge_share:
                t = r["l0Tier"]
                probs = {x: (0.7 if x == t else 0.15) for x in ("haiku", "sonnet", "opus")}
                f.write(json.dumps({"taskId": r["taskId"], "l1Tier": t, "l1Effort": r["l0Effort"], "l1Probs": {"tier": probs}}) + "\n")
    return path


def make_tiny_checkpoint(path: Path, encoder_id: str = TINY_ENCODER, max_len: int = 192, head_max_len: int = 64) -> Path:
    """A Laya checkpoint directory (`laya.load` layout) around a tiny random ModernBERT. Needs the laya package and HF cache."""
    from transformers import AutoTokenizer

    from laya.common import build_model

    from .laya_compat import load_train

    lt, _ = load_train()
    cfg = {"encoder": encoder_id, "head_layers": 1, "max_len": max_len, "head_max_len": head_max_len, "act_costs": {},
           "temperature": [1.0, 1.0, 1.0]}
    model = build_model(cfg)
    tok = AutoTokenizer.from_pretrained(encoder_id)
    lt.save_checkpoint(model, tok, cfg, str(path))
    return path
