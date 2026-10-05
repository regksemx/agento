"""T33: `~/.agento/dataset/tasks.jsonl` -> Laya typed-decision training rows.

    python -m agento_train.export --tasks ~/.agento/dataset/tasks.jsonl --out artifacts/<run>/data

Writes into `--out`:

    train.jsonl  calibration.jsonl  test.jsonl  [holdout.jsonl]   Laya rows: {id, state, questions, gold, weights, meta}
    distill.jsonl                                                  {id, split, text, y, w, soft}: input for the student
    splits.json                                                    counts, label mix, per-project table

Laya's own row schema is `{state, questions, gold}` (docs/finetune.md); `gold[qid].probabilities` is keyed by choice
label, by "false"/"true" for noul, and by the level index as a string for score. The extra keys (`id`, `weights`,
`meta`) are ignored by Laya and carry what agento needs: the per-question weight, the label source and the observed
cost used for the savings metrics. Rows contain scrubbed prompt text (`state`): they stay on the training box.

Decisions made here, all deliberate:

* Input = the daemon's header lines + the FIRST prompt only (`textin.render(INPUT_TEMPLATE, ...)`, brain/CONTRACT.md). Follow-ups (`text[1:]`) did not exist when the router has to
  decide, so using them would leak the future (`--with-followups` exists for experiments only).
* Labels are never read from `observed`: it is what the human chose, and training on it teaches "always Opus"
  (spec section 1). tier/effort come from the best label source per record, L2 > L1 > L0; plan_first and
  delegate_explore are derived from trajectory flags until a judge supplies them.
* Split by time (a router is used on tomorrow's tasks): last 15% by `startTs` -> test, the 15% before it ->
  calibration, the rest -> train. `--holdout-project` additionally keeps whole projects out of every split.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .textin import INPUT_TEMPLATE, join_text, mentions_files, prompt_lang, render
from .questions import (
    DERIVED_WEIGHT_FACTOR,
    EFFORTS,
    HEAD_OPTIONS,
    HEADS,
    LAYA_QUESTIONS,
    SOURCE_RANK,
    SOURCE_WEIGHT,
    TIERS,
)

DEFAULT_TASKS = "~/.agento/dataset/tasks.jsonl"
TEST_FRAC = 0.15
CALIB_FRAC = 0.15
HEAD_TOKENS = 600  # spec section 4: prompt head up to 600 tokens ...
TAIL_TOKENS = 200  # ... and tail up to 200
MAX_STATE_TOKENS = 840  # header + head + tail; Laya's 1024 minus the question head (~60-150) and specials
TRUNCATION_MARK = "\n[...]\n"
CHARS_PER_TOKEN = 3.0  # conservative for Russian under a 250k-vocabulary tokenizer when none is given

_START_KIND = {"first-prompt": "session", "compact": "clear", "clear": "clear", "idle": "cold"}


# ───────────────────────────────────────────── input text ─────────────────────────────────────────────


def build_context(rec: dict, prompt: str) -> dict:
    """The header fields of one task, in the daemon's `context` vocabulary (brain/CONTRACT.md).

    `lang` and `mentions` are computed on the FULL prompt, like the daemon does, so truncating the prompt for the teacher
    does not change them. `files_in_repo` and `git_dirty` are in the spec but not in `tasks.jsonl` v1: they render as the
    daemon's defaults (`unknown`, `0`), so the model cannot learn from them and the serving side may send them freely.
    `startKind` maps to the spec's vocabulary: first-prompt -> session, clear and compact -> clear (a clean point either
    way), idle -> cold.
    """
    c = rec.get("context") or {}
    ctx: dict = {"lang": prompt_lang(prompt), "mentions": mentions_files(prompt)}
    langs = [str(x) for x in (c.get("languages") or [])][:3]
    if langs:
        ctx["repo"] = langs
    if isinstance(c.get("contextTokensAtStart"), (int, float)) and not isinstance(c.get("contextTokensAtStart"), bool):
        ctx["ctx"] = c["contextTokensAtStart"]
    kind = c.get("startKind")
    if kind in _START_KIND:
        ctx["start"] = _START_KIND[kind]
        ctx["prev_task"] = "none" if kind == "first-prompt" else ("heavy" if c.get("prevTaskWasHeavy") else "light")
    return ctx


class CharTokenizer:
    """Fallback when no real tokenizer is given: one 'token' is `CHARS_PER_TOKEN` characters."""

    def __init__(self, chars_per_token: float = CHARS_PER_TOKEN):
        self.cpt = chars_per_token

    def count(self, text: str) -> int:
        return math.ceil(len(text) / self.cpt)

    def head(self, text: str, n: int) -> str:
        return text[: int(n * self.cpt)]

    def tail(self, text: str, n: int) -> str:
        k = int(n * self.cpt)
        return text[-k:] if k > 0 else ""


class HFTokenizer:
    """Exact budget with a HuggingFace tokenizer (`--tokenizer <id or path>`, e.g. the Laya multilingual one)."""

    def __init__(self, name_or_path: str):
        from transformers import AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(name_or_path)

    def _ids(self, text: str) -> list[int]:
        return self.tok.encode(text, add_special_tokens=False)

    def count(self, text: str) -> int:
        return len(self._ids(text))

    def head(self, text: str, n: int) -> str:
        return self.tok.decode(self._ids(text)[:n])

    def tail(self, text: str, n: int) -> str:
        ids = self._ids(text)
        return self.tok.decode(ids[-n:]) if n > 0 else ""


def truncate_head_tail(text: str, max_tokens: int, head_tokens: int = HEAD_TOKENS, tail_tokens: int = TAIL_TOKENS,
                       tok: Optional[Any] = None) -> str:
    """Keep the head and the tail of a long text, join them with `[...]`. A text that fits is returned unchanged.

    The kept part is at most `max_tokens` (head + tail + the marker). Head gets 3/4 of the budget up to `head_tokens`,
    the tail the rest up to `tail_tokens`: in a long prompt the instruction sits at the start and the ask at the end.
    """
    tok = tok or CharTokenizer()
    if max_tokens <= 0:
        return ""
    if tok.count(text) <= max_tokens:
        return text
    budget = max(2, max_tokens - tok.count(TRUNCATION_MARK) - 1)
    head = min(head_tokens, max(1, int(budget * 0.75)))
    tail = min(tail_tokens, budget - head)
    return tok.head(text, head).rstrip() + TRUNCATION_MARK + (tok.tail(text, tail).lstrip() if tail > 0 else "")


def build_state(rec: dict, tok: Optional[Any] = None, max_state_tokens: int = MAX_STATE_TOKENS,
                with_followups: bool = False) -> Optional[tuple[str, str]]:
    """`(teacher_state, full_text)` for a record, or None when it has no prompt text.

    Both are `render(INPUT_TEMPLATE, prompt, context)`: `full_text` with the whole prompt (what the student and the daemon
    see; the student truncates at token level), `teacher_state` with the prompt cut head/tail so that header + prompt fit
    `max_state_tokens` (Laya's window is 1024 tokens minus its question head).
    """
    texts = [t for t in (rec.get("text") or []) if isinstance(t, str) and t.strip()]
    if not texts:
        return None
    prompt = join_text(texts) if with_followups else texts[0]
    prompt = prompt.strip()
    ctx = build_context(rec, prompt)
    full = render(INPUT_TEMPLATE, prompt, ctx)
    tok = tok or CharTokenizer()
    body_budget = max_state_tokens - tok.count(render(INPUT_TEMPLATE, "", ctx)) - 2
    return render(INPUT_TEMPLATE, truncate_head_tail(prompt, body_budget, tok=tok), ctx), full


# ───────────────────────────────────────────── labels ─────────────────────────────────────────────


def _norm(key: str) -> str:
    return re.sub(r"[_\s-]", "", key).lower()


def _source_view(rec: dict, level: str) -> dict:
    """Fields of one label level as a flat dict with normalised keys.

    Accepts a nested object (`l1: {tier, effort, probs}`) and flat camelCase fields (`l1Tier`, `l1Effort`, `l1Probs`,
    `l2Tier`, ...), the shape the owner described; both may be present.
    """
    out: dict[str, Any] = {}
    nested = rec.get(level)
    if isinstance(nested, dict):
        out.update({_norm(k): v for k, v in nested.items()})
    for k, v in rec.items():
        if len(k) > 2 and k.lower().startswith(level) and k.lower() != level:
            out.setdefault(_norm(k[2:]), v)
    return out


def _probs_vector(value: Any, options: tuple[str, ...]) -> Optional[list[float]]:
    """A distribution over `options` from a dict keyed by option (or index) or from a list; normalised, or None."""
    vec: Optional[list[float]] = None
    if isinstance(value, dict):
        low = {str(k).lower(): v for k, v in value.items()}
        if all(o in low for o in options):
            vec = [low[o] for o in options]
        elif all(str(i) in low for i in range(len(options))):
            vec = [low[str(i)] for i in range(len(options))]
    elif isinstance(value, (list, tuple)) and len(value) == len(options):
        vec = list(value)
    if vec is None:
        return None
    try:
        vec = [float(v) for v in vec]
    except (TypeError, ValueError):
        return None
    if any((not math.isfinite(v)) or v < 0 for v in vec) or sum(vec) <= 0:
        return None
    s = sum(vec)
    return [v / s for v in vec]


def _label_from_view(view: dict, head: str) -> Optional[tuple[int, Optional[list[float]]]]:
    """`(index, soft distribution or None)` for `head` in one source view, or None when it does not label the head."""
    options = HEAD_OPTIONS[head]
    key = _norm(head)
    probs: Optional[list[float]] = None
    raw_probs = view.get("probs")
    if isinstance(raw_probs, dict):
        nested = {_norm(k): v for k, v in raw_probs.items()}
        probs = _probs_vector(nested.get(key), options) if key in nested else None
        if probs is None and head in ("tier", "effort"):
            probs = _probs_vector(raw_probs, options)  # flat {haiku, sonnet, opus} / {low, medium, high}
    label_idx: Optional[int] = None
    raw = view.get(key)
    if isinstance(raw, str) and raw.strip().lower() in options:
        label_idx = options.index(raw.strip().lower())
    elif head in ("plan_first", "delegate_explore") and raw is not None:
        if isinstance(raw, bool):
            label_idx = int(raw)
        elif isinstance(raw, (int, float)) and math.isfinite(raw) and 0 <= raw <= 1:
            label_idx = int(raw >= 0.5)
            probs = probs or [1.0 - float(raw), float(raw)]
        elif isinstance(raw, str) and raw.strip().lower() in ("true", "false"):
            label_idx = int(raw.strip().lower() == "true")
    if label_idx is None and probs is not None:
        label_idx = max(range(len(options)), key=lambda i: probs[i])
    if label_idx is None:
        return None
    return label_idx, probs


def _l0_plan_first(rec: dict) -> bool:
    """Weak plan_first: ExitPlanMode was used, or Opus-heavy work that touched many files."""
    obs = rec.get("observed") or {}
    return bool(obs.get("planMode")) or (rec.get("l0Tier") == "opus" and (obs.get("filesEdited") or 0) >= 6)


def _l0_delegate_explore(rec: dict) -> bool:
    """Weak delegate_explore: the task already used an Explore/scout subagent."""
    types = (rec.get("observed") or {}).get("subagentTypes") or []
    return any(("explore" in str(t).lower() or "scout" in str(t).lower()) for t in types)


def _l0_label(rec: dict, head: str) -> Optional[int]:
    if head == "tier":
        return TIERS.index(rec["l0Tier"]) if rec.get("l0Tier") in TIERS else None
    if head == "effort":
        return EFFORTS.index(rec["l0Effort"]) if rec.get("l0Effort") in EFFORTS else None
    if head == "plan_first":
        return int(_l0_plan_first(rec))
    return int(_l0_delegate_explore(rec))


def resolve_labels(rec: dict) -> dict[str, dict]:
    """Per head the best available label: `{head: {idx, probs, source, weight}}`, L2 > L1 > L0.

    The source is chosen per head: a record whose L2 replay only labels the tier still takes its effort from L1/L0.
    `probs` is the soft target (a judge's distribution) or a one-hot; `weight` is `SOURCE_WEIGHT[source]`, times
    `DERIVED_WEIGHT_FACTOR` for an L0 label that is derived from trajectory flags (plan_first, delegate_explore).
    """
    views = {"L2": _source_view(rec, "l2"), "L1": _source_view(rec, "l1")}
    out: dict[str, dict] = {}
    for head in HEADS:
        n = len(HEAD_OPTIONS[head])
        found = None
        for source in ("L2", "L1"):
            got = _label_from_view(views[source], head)
            if got is not None:
                idx, probs = got
                found = (idx, probs, source, SOURCE_WEIGHT[source])
                break
        if found is None:
            idx = _l0_label(rec, head)
            if idx is None:
                continue
            w = SOURCE_WEIGHT["L0"] * (DERIVED_WEIGHT_FACTOR if head in ("plan_first", "delegate_explore") else 1.0)
            found = (idx, None, "L0", w)
        idx, probs, source, w = found
        if probs is None:
            probs = [1.0 if i == idx else 0.0 for i in range(n)]
        out[head] = {"idx": idx, "probs": probs, "source": source, "weight": w}
    return out


def gold_for_laya(head: str, lab: dict) -> dict:
    """The `gold[qid]` object of Laya's row schema for one question."""
    options = HEAD_OPTIONS[head]
    probs = lab["probs"]
    if head == "tier":
        return {"label": options[lab["idx"]], "probabilities": {o: probs[i] for i, o in enumerate(options)}}
    if head == "effort":
        return {"label": lab["idx"], "probabilities": {str(i): probs[i] for i in range(len(options))}}
    return {"label": "true" if lab["idx"] else "false", "probabilities": {"false": probs[0], "true": probs[1]}}


# ───────────────────────────────────────────── reading ─────────────────────────────────────────────


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError("%s:%d is not valid JSON: %s" % (path, n, e)) from e
    return rows


# `agento dataset judge` writes per-configuration success probabilities (cheapest first) and two flags at the top level.
JUDGE_CONFIGS = ("haiku-low", "sonnet-medium", "sonnet-high", "opus-medium")


def from_agento_judge(row: dict) -> Optional[dict]:
    """An `agento dataset judge` line as the nested `l1` view; failed verdicts are dropped (None).

    Success probabilities become soft targets over the cheapest sufficient option: P(haiku) = p(haiku-low),
    P(sonnet) = p(best sonnet) - P(haiku), P(opus) = the rest (made monotone first). Lines in another shape pass through.
    """
    if row.get("ok") is False:
        return None
    probs = row.get("l1Probs")
    flags = {head: row[key] for key, head in (("needsPlanFirst", "plan_first"), ("delegateExplore", "delegate_explore"))
             if isinstance(row.get(key), bool)}
    has_probs = isinstance(probs, dict) and all(isinstance(probs.get(c), (int, float)) for c in JUDGE_CONFIGS)
    if not has_probs and not flags:
        return row
    out = {k: v for k, v in row.items() if k not in ("l1Probs", "needsPlanFirst", "delegateExplore")}
    l1 = dict(out.get("l1") or {})
    l1.update(flags)
    if has_probs:
        hl, sm, sh, om = (min(1.0, max(0.0, float(probs[c]))) for c in JUDGE_CONFIGS)
        sm = max(sm, hl)
        sh = max(sh, sm)
        tier = (hl, sh - hl, 1.0 - sh)
        # Effort of the cheapest sufficient configuration; the opus fallback runs at medium.
        effort = (hl, (sm - hl) + (1.0 - sh), sh - sm)
        l1["probs"] = {"tier": dict(zip(TIERS, tier)), "effort": dict(zip(EFFORTS, effort))}
    out["l1"] = l1
    return out


def merge_judge(records: list[dict], judge_dir: Optional[Path]) -> int:
    """Merge `judge/*.jsonl` (L1 judge / L2 replay output, keyed by `taskId`) into the task records, in file-name order.

    A judge line may carry its labels flat (`l1Tier`) or nested (`l1: {...}`); the later file wins per field. Returns
    the number of records that received at least one judge line.
    """
    if judge_dir is None or not judge_dir.is_dir():
        return 0
    by_id = {r["taskId"]: r for r in records if "taskId" in r}
    touched = set()
    for path in sorted(judge_dir.glob("*.jsonl")):
        for raw in read_jsonl(path):
            row = from_agento_judge(raw)
            if row is None:
                continue
            tid = row.get("taskId") or row.get("id")
            rec = by_id.get(tid)
            if rec is None:
                continue
            for k, v in row.items():
                if k in ("taskId", "id", "v"):
                    continue
                if isinstance(v, dict) and isinstance(rec.get(k), dict):
                    rec[k] = {**rec[k], **v}
                else:
                    rec[k] = v
            touched.add(tid)
    return len(touched)


# ───────────────────────────────────────────── splitting ─────────────────────────────────────────────


def time_split(records: list[dict], test_frac: float = TEST_FRAC, calib_frac: float = CALIB_FRAC,
               holdout_projects: Iterable[str] = ()) -> dict[str, list[dict]]:
    """`{train, calibration, test, holdout}` by time.

    Records of a `holdout_projects` project (case-insensitive substring of `project`) go to `holdout` and take no part
    in the time split. The rest is sorted by `(startTs, taskId)`: the last `test_frac` is test, the `calib_frac`
    before it is calibration, everything older is train. Calibration and test never overlap train in time.
    """
    pats = [p.lower() for p in holdout_projects if p]
    holdout = [r for r in records if any(p in str(r.get("project", "")).lower() for p in pats)] if pats else []
    held = {id(r) for r in holdout}
    pool = sorted((r for r in records if id(r) not in held), key=lambda r: (r.get("startTs", 0), r.get("taskId", "")))
    n = len(pool)
    n_test = int(round(n * test_frac))
    n_cal = int(round(n * calib_frac))
    if n >= 3:
        n_test, n_cal = max(1, n_test), max(1, n_cal)
    if n_test + n_cal >= n:
        n_test, n_cal = n // 3, n // 3
    n_train = n - n_test - n_cal
    return {
        "train": pool[:n_train],
        "calibration": pool[n_train : n_train + n_cal],
        "test": pool[n_train + n_cal :],
        "holdout": holdout,
    }


# ───────────────────────────────────────────── rows ─────────────────────────────────────────────


def build_row(rec: dict, split: str, tok: Optional[Any] = None, max_state_tokens: int = MAX_STATE_TOKENS,
              with_followups: bool = False) -> Optional[dict]:
    """One Laya training row, or None when the record has no usable prompt or label."""
    built = build_state(rec, tok, max_state_tokens, with_followups)
    if built is None:
        return None
    state, full_text = built
    labels = resolve_labels(rec)
    if "tier" not in labels or "effort" not in labels:
        return None
    obs = rec.get("observed") or {}
    rules = rec.get("rulesVerdict") or {}
    return {
        "id": rec["taskId"],
        "state": state,
        "text": full_text,
        "questions": LAYA_QUESTIONS,
        "gold": {h: gold_for_laya(h, lab) for h, lab in labels.items()},
        "weights": {h: lab["weight"] for h, lab in labels.items()},
        "meta": {
            "split": split,
            "project": rec.get("project", ""),
            "startTs": rec.get("startTs", 0),
            "labels": {h: lab["idx"] for h, lab in labels.items()},
            "sources": {h: lab["source"] for h, lab in labels.items()},
            "weights": {h: lab["weight"] for h, lab in labels.items()},
            "obs_tier": obs.get("modelTier", "unknown"),
            "obs_effort": obs.get("effort"),
            "cost": float(obs.get("cost") or 0.0),
            "out_tokens": int(obs.get("outputTokens") or 0),
            "rules": {"tier": rules.get("tier"), "effort": rules.get("effort")},
            "l0": {"tier": rec.get("l0Tier"), "effort": rec.get("l0Effort")},
            "label_source": rec.get("labelSource", "L0"),
        },
    }


def distill_record(row: dict) -> dict:
    """The small record the student trains on: text, hard labels, weights and soft targets per head."""
    soft = {}
    for h, g in row["gold"].items():
        p = g["probabilities"]
        soft[h] = [p[o] for o in HEAD_OPTIONS[h]] if h == "tier" else (
            [p[str(i)] for i in range(len(HEAD_OPTIONS[h]))] if h == "effort" else [p["false"], p["true"]])
    return {"id": row["id"], "split": row["meta"]["split"], "text": row["text"], "y": row["meta"]["labels"],
            "w": row["meta"]["weights"], "soft": soft}


def split_stats(rows_by_split: dict[str, list[dict]]) -> dict:
    """Counts, label mix and the per-project table written to `splits.json`."""
    stats: dict[str, Any] = {"counts": {s: len(r) for s, r in rows_by_split.items()}, "labels": {}, "sources": {},
                             "span": {}, "per_project": {}}
    for split, rows in rows_by_split.items():
        mix = {h: Counter() for h in HEADS}
        src = Counter()
        for r in rows:
            for h, idx in r["meta"]["labels"].items():
                mix[h][HEAD_OPTIONS[h][idx]] += 1
            src[r["meta"]["label_source"]] += 1
        stats["labels"][split] = {h: dict(c) for h, c in mix.items()}
        stats["sources"][split] = dict(src)
        ts = [r["meta"]["startTs"] for r in rows]
        stats["span"][split] = [min(ts), max(ts)] if ts else None
        for r in rows:
            p = stats["per_project"].setdefault(r["meta"]["project"] or "?", {s: 0 for s in rows_by_split})
            p[split] += 1
    stats["per_project"] = dict(sorted(stats["per_project"].items(), key=lambda kv: -sum(kv[1].values())))
    return stats


def export(tasks_path: Path, out_dir: Path, judge_dir: Optional[Path] = None, tokenizer: Optional[str] = None,
           max_state_tokens: int = MAX_STATE_TOKENS, holdout_projects: Iterable[str] = (),
           with_followups: bool = False, test_frac: float = TEST_FRAC, calib_frac: float = CALIB_FRAC,
           log: Callable[[str], None] = print) -> dict:
    records = read_jsonl(tasks_path)
    if not records:
        raise SystemExit("export: %s has no records" % tasks_path)
    merged = merge_judge(records, judge_dir)
    tok = HFTokenizer(tokenizer) if tokenizer else None
    if tok is None:
        log("export: no --tokenizer, truncation uses %.1f chars/token (conservative)" % CHARS_PER_TOKEN)
    splits = time_split(records, test_frac, calib_frac, holdout_projects)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows_by_split: dict[str, list[dict]] = {}
    skipped = 0
    for split, recs in splits.items():
        rows = []
        for rec in recs:
            row = build_row(rec, split, tok, max_state_tokens, with_followups)
            if row is None:
                skipped += 1
            else:
                rows.append(row)
        rows_by_split[split] = rows
        if split != "holdout" or rows:
            with open(out_dir / ("%s.jsonl" % split), "w", encoding="utf-8") as f:
                for row in rows:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(out_dir / "distill.jsonl", "w", encoding="utf-8") as f:
        for rows in rows_by_split.values():
            for row in rows:
                f.write(json.dumps(distill_record(row), ensure_ascii=False) + "\n")
    stats = split_stats(rows_by_split)
    stats.update({"tasks_file": str(tasks_path), "records": len(records), "skipped": skipped,
                  "judge_merged": merged, "holdout_projects": list(holdout_projects),
                  "max_state_tokens": max_state_tokens, "tokenizer": tokenizer or "chars/%.1f" % CHARS_PER_TOKEN,
                  "with_followups": with_followups})
    with open(out_dir / "splits.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    log("export: %d records -> %s (skipped %d)" % (len(records), ", ".join("%s %d" % (s, len(r)) for s, r in rows_by_split.items()), skipped))
    if any(len(rows_by_split[s]) < 10 for s in ("train", "calibration", "test")):
        log("export: WARNING a split has fewer than 10 rows; metrics and calibration will be noise")
    return stats


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tasks", default=DEFAULT_TASKS, help="tasks.jsonl (default %(default)s)")
    ap.add_argument("--judge-dir", default=None, help="directory with L1/L2 *.jsonl (default: <tasks dir>/judge if it exists)")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--tokenizer", default=None, help="HF tokenizer id/path for exact token budgets (else chars/3)")
    ap.add_argument("--max-state-tokens", type=int, default=MAX_STATE_TOKENS)
    ap.add_argument("--holdout-project", action="append", default=[], metavar="SUBSTR",
                    help="keep every task of projects matching SUBSTR out of train/calibration/test (repeatable)")
    ap.add_argument("--with-followups", action="store_true", help="also feed follow-up prompts (leaks the future; experiments only)")
    ap.add_argument("--test-frac", type=float, default=TEST_FRAC)
    ap.add_argument("--calib-frac", type=float, default=CALIB_FRAC)
    a = ap.parse_args(argv)
    tasks = Path(a.tasks).expanduser()
    judge = Path(a.judge_dir).expanduser() if a.judge_dir else tasks.parent / "judge"
    export(tasks, Path(a.out), judge, a.tokenizer, a.max_state_tokens, a.holdout_project, a.with_followups,
           a.test_frac, a.calib_frac)
    return 0


if __name__ == "__main__":
    sys.exit(main())
