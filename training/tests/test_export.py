"""Export: splits, label precedence, truncation, question mapping. Pure Python, no torch."""
import json
from pathlib import Path

import pytest

from agento_train import export
from agento_train.export import (CharTokenizer, build_context, build_row, build_state, merge_judge, resolve_labels,
                                 time_split, truncate_head_tail)
from agento_train.questions import LAYA_QUESTIONS, SOURCE_WEIGHT
from agento_train.smoke import synthetic_tasks, write_synthetic_tasks
from agento_train.textin import INPUT_TEMPLATE


def rec(**kw):
    base = {"v": 1, "taskId": "t1", "project": "~/p", "startTs": 1000, "text": ["Исправь баг в src/app.ts", "и ещё"],
            "context": {"contextTokensAtStart": 82000, "startKind": "first-prompt", "languages": ["kotlin", "gradle"],
                        "hasGitBranch": True, "prevTaskWasHeavy": False},
            "observed": {"modelTier": "opus", "cost": 3.0, "outputTokens": 1000, "planMode": False, "filesEdited": 1,
                         "subagentTypes": []},
            "l0Tier": "sonnet", "l0Effort": "medium", "rulesVerdict": {"tier": "opus", "effort": "high"}, "labelSource": "L0"}
    base.update(kw)
    return base


# ---------------------------------------------------------------- splits

def test_time_split_proportions_and_order():
    recs = synthetic_tasks(200)
    recs.reverse()  # input order must not matter
    sp = time_split(recs)
    assert len(sp["test"]) == 30 and len(sp["calibration"]) == 30 and len(sp["train"]) == 140
    assert max(r["startTs"] for r in sp["train"]) <= min(r["startTs"] for r in sp["calibration"])
    assert max(r["startTs"] for r in sp["calibration"]) <= min(r["startTs"] for r in sp["test"])
    ids = [r["taskId"] for s in sp.values() for r in s]
    assert len(ids) == len(set(ids)) == 200


def test_time_split_holdout_project_excluded_from_pool():
    recs = synthetic_tasks(200)
    proj = recs[0]["project"]
    n_proj = sum(r["project"] == proj for r in recs)
    sp = time_split(recs, holdout_projects=[proj.split("/")[-1].upper()])  # case-insensitive substring
    assert len(sp["holdout"]) == n_proj
    assert all(r["project"] != proj for s in ("train", "calibration", "test") for r in sp[s])
    assert len(sp["test"]) == round((200 - n_proj) * 0.15)


def test_time_split_tiny_input_does_not_crash():
    sp = time_split(synthetic_tasks(5))
    assert sum(len(v) for v in sp.values()) == 5 and sp["train"] and sp["test"]


# ---------------------------------------------------------------- label precedence

def test_l0_labels_and_weights():
    lab = resolve_labels(rec())
    assert lab["tier"]["source"] == "L0" and lab["tier"]["idx"] == 1 and lab["tier"]["weight"] == SOURCE_WEIGHT["L0"]
    assert lab["effort"]["idx"] == 1
    # derived binary heads count for less than a real L0 label
    assert lab["plan_first"]["weight"] < SOURCE_WEIGHT["L0"]
    assert lab["plan_first"]["idx"] == 0 and lab["delegate_explore"]["idx"] == 0


def test_derived_binary_labels():
    r = rec(observed={"planMode": True, "subagentTypes": ["Explore"], "filesEdited": 0})
    lab = resolve_labels(r)
    assert lab["plan_first"]["idx"] == 1 and lab["delegate_explore"]["idx"] == 1
    r = rec(l0Tier="opus", observed={"planMode": False, "subagentTypes": [], "filesEdited": 7})
    assert resolve_labels(r)["plan_first"]["idx"] == 1


def test_l1_beats_l0_with_probs_and_l2_beats_l1():
    r = rec(l1Tier="haiku", l1Effort="low", l1Probs={"tier": {"haiku": 0.6, "sonnet": 0.3, "opus": 0.1}})
    lab = resolve_labels(r)
    assert lab["tier"]["source"] == "L1" and lab["tier"]["idx"] == 0 and lab["tier"]["weight"] == SOURCE_WEIGHT["L1"]
    assert lab["tier"]["probs"] == pytest.approx([0.6, 0.3, 0.1])
    assert lab["effort"]["source"] == "L1" and lab["effort"]["probs"] == [1.0, 0.0, 0.0]
    r.update({"l2Tier": "sonnet"})
    lab = resolve_labels(r)
    assert lab["tier"]["source"] == "L2" and lab["tier"]["idx"] == 1 and lab["tier"]["weight"] == 1.0
    assert lab["effort"]["source"] == "L1"  # per head: L2 only labelled the tier


def test_nested_and_flat_probs_forms():
    r = rec(l1={"tier": "opus", "effort": "high", "probs": {"haiku": 0.1, "sonnet": 0.2, "opus": 0.7, "low": 0.1, "medium": 0.2, "high": 0.7}})
    lab = resolve_labels(r)
    assert lab["tier"]["idx"] == 2 and lab["tier"]["probs"] == pytest.approx([0.1, 0.2, 0.7])
    assert lab["effort"]["probs"] == pytest.approx([0.1, 0.2, 0.7])


def test_probs_only_label_is_argmax_and_garbage_is_ignored():
    r = rec(l1Probs={"tier": [0.2, 0.5, 0.3]})
    assert resolve_labels(r)["tier"]["idx"] == 1
    r = rec(l1Tier="gpt-4", l1Probs={"tier": {"haiku": -1, "sonnet": 1, "opus": 1}})
    assert resolve_labels(r)["tier"]["source"] == "L0"


def test_judge_dir_merge(tmp_path):
    recs = [rec(taskId="a"), rec(taskId="b")]
    d = tmp_path / "judge"
    d.mkdir()
    (d / "1.jsonl").write_text(json.dumps({"taskId": "a", "l1Tier": "haiku"}) + "\n" + json.dumps({"taskId": "zzz", "l1Tier": "opus"}) + "\n")
    (d / "2.jsonl").write_text(json.dumps({"taskId": "a", "l2Tier": "opus"}) + "\n")
    assert merge_judge(recs, d) == 1
    lab = resolve_labels(recs[0])
    assert lab["tier"]["source"] == "L2" and lab["tier"]["idx"] == 2
    assert resolve_labels(recs[1])["tier"]["source"] == "L0"
    assert merge_judge(recs, tmp_path / "missing") == 0


# ---------------------------------------------------------------- truncation and input text

def test_truncate_short_text_unchanged_and_long_keeps_head_and_tail():
    assert truncate_head_tail("short", 100) == "short"
    text = "HEAD" + "x" * 5000 + "TAIL"
    out = truncate_head_tail(text, 200, head_tokens=150, tail_tokens=50)
    assert out.startswith("HEAD") and out.endswith("TAIL") and "[...]" in out
    assert CharTokenizer().count(out) <= 200
    # the head gets the larger share
    assert out.index("[...]") > len(out) - out.index("[...]") - 5


def test_truncate_with_token_counter_budget():
    class WordTok:  # one token per word
        def count(self, t): return len(t.split())
        def head(self, t, n): return " ".join(t.split()[:n])
        def tail(self, t, n): return " ".join(t.split()[-n:]) if n > 0 else ""
    text = " ".join("w%d" % i for i in range(2000))
    out = truncate_head_tail(text, 100, head_tokens=600, tail_tokens=200, tok=WordTok())
    assert WordTok().count(out) <= 100 and out.startswith("w0 ") and out.endswith("w1999")


def test_state_is_the_daemon_template_and_uses_first_prompt_only():
    state, full = build_state(rec())
    assert state == full
    assert state.startswith("[lang=ru][repo=kotlin,gradle][ctx=82k][files_in_repo=unknown][start=session]\n"
                            "[prev_task=none][git_dirty=0][mentions=1]\n")
    assert state.endswith("Исправь баг в src/app.ts") and "и ещё" not in state
    _, with_follow = build_state(rec(), with_followups=True)
    assert with_follow.endswith("Исправь баг в src/app.ts\n\nи ещё")


def test_context_start_vocabulary():
    c = build_context(rec(context={"startKind": "idle", "prevTaskWasHeavy": True, "languages": []}), "x")
    assert c["start"] == "cold" and c["prev_task"] == "heavy" and "repo" not in c
    assert build_context(rec(context={"startKind": "compact"}), "x")["start"] == "clear"


def test_long_prompt_truncated_for_teacher_but_full_text_kept():
    long = "ВВЕДЕНИЕ " + "слово " * 3000 + "КОНЕЦ"
    state, full = build_state(rec(text=[long]), max_state_tokens=300)
    assert len(state) < len(full) and "[...]" in state
    assert state.startswith("[lang=ru]") and state.endswith("КОНЕЦ") and full.endswith("КОНЕЦ")
    assert CharTokenizer().count(state) <= 300


def test_no_prompt_no_row():
    assert build_state(rec(text=[])) is None
    assert build_row(rec(text=["   "]), "train") is None


# ---------------------------------------------------------------- question mapping / row shape

def test_laya_questions_are_valid_for_laya():
    laya = pytest.importorskip("laya.agent")
    for qid, q in LAYA_QUESTIONS.items():
        laya.Agent._check_question(qid, q)
    assert LAYA_QUESTIONS["tier"]["type"] == "choice" and list(LAYA_QUESTIONS["tier"]["criteria"]) == ["haiku", "sonnet", "opus"]
    assert LAYA_QUESTIONS["effort"]["type"] == "score" and len(LAYA_QUESTIONS["effort"]["criteria"]) == 3
    assert LAYA_QUESTIONS["plan_first"]["type"] == LAYA_QUESTIONS["delegate_explore"]["type"] == "noul"


def test_row_matches_laya_schema():
    row = build_row(rec(l1Tier="opus", l1Probs={"tier": {"haiku": 0.0, "sonnet": 0.25, "opus": 0.75}}), "train")
    assert set(row) >= {"id", "state", "questions", "gold", "weights", "meta"}
    g = row["gold"]
    assert g["tier"]["label"] == "opus" and g["tier"]["probabilities"] == {"haiku": 0.0, "sonnet": 0.25, "opus": 0.75}
    assert g["effort"]["label"] == 1 and g["effort"]["probabilities"] == {"0": 0.0, "1": 1.0, "2": 0.0}
    assert g["plan_first"]["label"] == "false" and g["plan_first"]["probabilities"] == {"false": 1.0, "true": 0.0}
    assert row["weights"]["tier"] == SOURCE_WEIGHT["L1"] and row["weights"]["effort"] == SOURCE_WEIGHT["L0"]
    m = row["meta"]
    assert m["labels"] == {"tier": 2, "effort": 1, "plan_first": 0, "delegate_explore": 0}
    assert m["obs_tier"] == "opus" and m["cost"] == 3.0 and m["rules"]["tier"] == "opus"
    json.dumps(row)


def test_end_to_end_files(tmp_path):
    tasks = write_synthetic_tasks(tmp_path / "in" / "tasks.jsonl", n=100)
    stats = export.export(tasks, tmp_path / "out", tasks.parent / "judge", log=lambda *_: None)
    assert stats["counts"] == {"train": 70, "calibration": 15, "test": 15, "holdout": 0}
    assert stats["judge_merged"] > 0
    for name in ("train", "calibration", "test", "distill", "splits"):
        assert (tmp_path / "out" / ("%s.jsonl" % name if name != "splits" else "splits.json")).exists()
    d = [json.loads(l) for l in open(tmp_path / "out" / "distill.jsonl")]
    assert len(d) == 100 and set(d[0]) == {"id", "split", "text", "y", "w", "soft"}
    assert d[0]["text"].startswith("[lang=") and sum(d[0]["soft"]["tier"]) == pytest.approx(1.0)
    assert any(r["w"]["tier"] == SOURCE_WEIGHT["L1"] for r in d)  # judged records carry the L1 weight
    assert INPUT_TEMPLATE.split("{text}")[0].split("\n")[0].startswith("[lang=")


def test_agento_judge_lines_become_soft_l1_targets():
    from agento_train.export import from_agento_judge

    row = {
        "v": 1, "taskId": "t1", "ok": True, "l1Tier": "sonnet", "l1Effort": "medium",
        "l1Probs": {"haiku-low": 0.2, "sonnet-medium": 0.7, "sonnet-high": 0.9, "opus-medium": 0.95},
        "needsPlanFirst": True, "delegateExplore": False,
    }
    out = from_agento_judge(row)
    assert "l1Probs" not in out and "needsPlanFirst" not in out
    assert out["l1"]["plan_first"] is True and out["l1"]["delegate_explore"] is False
    tier = out["l1"]["probs"]["tier"]
    assert abs(tier["haiku"] - 0.2) < 1e-9 and abs(tier["sonnet"] - 0.7) < 1e-9 and abs(tier["opus"] - 0.1) < 1e-9
    effort = out["l1"]["probs"]["effort"]
    assert abs(sum(effort.values()) - 1.0) < 1e-9 and effort["low"] == 0.2
    assert out["l1Tier"] == "sonnet"


def test_agento_judge_failures_are_dropped_and_non_monotone_probs_repaired():
    from agento_train.export import from_agento_judge

    assert from_agento_judge({"taskId": "t", "ok": False, "error": "parse"}) is None
    out = from_agento_judge({"taskId": "t", "ok": True, "l1Probs": {"haiku-low": 0.8, "sonnet-medium": 0.3, "sonnet-high": 0.2, "opus-medium": 0.9}})
    tier = out["l1"]["probs"]["tier"]
    assert all(v >= 0 for v in tier.values()) and abs(sum(tier.values()) - 1.0) < 1e-9 and tier["haiku"] == 0.8


def test_merge_judge_applies_agento_judge_flags(tmp_path):
    import json
    from agento_train.export import merge_judge, resolve_labels

    judge = tmp_path / "judge"
    judge.mkdir()
    (judge / "openai-x.jsonl").write_text(json.dumps({
        "v": 1, "taskId": "a", "ok": True, "l1Tier": "haiku", "l1Effort": "low",
        "l1Probs": {"haiku-low": 0.9, "sonnet-medium": 0.95, "sonnet-high": 0.97, "opus-medium": 0.99},
        "needsPlanFirst": False, "delegateExplore": True,
    }) + "\n" + json.dumps({"v": 1, "taskId": "a", "ok": False}) + "\n")
    recs = [{"taskId": "a", "l0Tier": "opus", "l0Effort": "high", "observed": {"planMode": True}}]
    assert merge_judge(recs, judge) == 1
    labels = resolve_labels(recs[0])
    assert labels["tier"]["source"] == "L1" and labels["tier"]["idx"] == 0
    assert labels["delegate_explore"]["idx"] == 1 and labels["plan_first"]["idx"] == 0


# ---------------------------------------------------------------- human labels (agento dataset label -> judge/human.jsonl)

def human_line(task_id, tier="haiku", effort="low", plan=False, delegate=True, **kw):
    """A line exactly as `agento dataset label` writes it (cli/src/dataset/label/store.ts makeRecord)."""
    row = {"v": 1, "taskId": task_id, "ok": True, "ts": 1790000000000, "labelSource": "human",
           "labeledAt": "2026-10-05T10:00:00.000Z", "labelerSeconds": 12, "unsure": tier is None,
           "l2Tier": tier, "l2Effort": effort, "l2PlanFirst": plan, "l2DelegateExplore": delegate}
    row.update(kw)
    return json.dumps(row)


L1_LINE = json.dumps({
    "v": 1, "taskId": "a", "ok": True, "l1Tier": "opus", "l1Effort": "medium",
    "l1Probs": {"haiku-low": 0.05, "sonnet-medium": 0.1, "sonnet-high": 0.2, "opus-medium": 0.9},
    "needsPlanFirst": True, "delegateExplore": False,
})


def test_human_labels_are_gold_for_all_four_heads(tmp_path):
    d = tmp_path / "judge"
    d.mkdir()
    (d / "openai-x.jsonl").write_text(L1_LINE + "\n")
    (d / "human.jsonl").write_text(human_line("a", "haiku", "low", plan=False, delegate=True) + "\n")
    recs = [rec(taskId="a")]
    assert merge_judge(recs, d) == 1
    labels = resolve_labels(recs[0])
    assert {h: labels[h]["source"] for h in labels} == {"tier": "L2", "effort": "L2", "plan_first": "L2", "delegate_explore": "L2"}
    assert {h: labels[h]["weight"] for h in labels} == {h: SOURCE_WEIGHT["L2"] for h in labels} and SOURCE_WEIGHT["L2"] == 1.0
    assert (labels["tier"]["idx"], labels["effort"]["idx"], labels["plan_first"]["idx"], labels["delegate_explore"]["idx"]) == (0, 0, 0, 1)
    assert labels["tier"]["probs"] == [1.0, 0.0, 0.0]  # one-hot gold, not the judge's soft target
    row = build_row(recs[0], "train")
    assert row["meta"]["sources"] == {"tier": "L2", "effort": "L2", "plan_first": "L2", "delegate_explore": "L2"}
    assert row["gold"]["plan_first"]["label"] == "false" and row["gold"]["delegate_explore"]["label"] == "true"
    assert row["meta"]["label_source"] == "human"


def test_human_labels_win_even_when_a_later_file_has_l2_fields(tmp_path):
    d = tmp_path / "judge"
    d.mkdir()
    (d / "human.jsonl").write_text(human_line("a", "sonnet", "medium", plan=True, delegate=False) + "\n")
    (d / "zzz-replay.jsonl").write_text(json.dumps({"taskId": "a", "l2Tier": "opus", "l2Effort": "high"}) + "\n")
    recs = [rec(taskId="a")]
    merge_judge(recs, d)
    labels = resolve_labels(recs[0])
    assert labels["tier"]["idx"] == 1 and labels["effort"]["idx"] == 1 and labels["plan_first"]["idx"] == 1


def test_human_relabel_last_wins_and_unsure_falls_back_to_l1(tmp_path):
    d = tmp_path / "judge"
    d.mkdir()
    (d / "openai-x.jsonl").write_text(L1_LINE + "\n")
    (d / "human.jsonl").write_text(
        human_line("a", "haiku", "low", plan=False, delegate=True) + "\n"
        + human_line("a", "sonnet", "high", plan=True, delegate=False) + "\n"
    )
    recs = [rec(taskId="a")]
    merge_judge(recs, d)
    labels = resolve_labels(recs[0])
    assert (labels["tier"]["idx"], labels["effort"]["idx"], labels["plan_first"]["idx"], labels["delegate_explore"]["idx"]) == (1, 2, 1, 0)

    # "don't remember" after a full verdict: explicit nulls replace every gold field, so the L1 judge is used again
    (d / "human.jsonl").write_text(
        human_line("a", "haiku", "low") + "\n" + human_line("a", None, None, plan=None, delegate=None) + "\n")
    recs = [rec(taskId="a")]
    merge_judge(recs, d)
    labels = resolve_labels(recs[0])
    assert {h: labels[h]["source"] for h in labels} == {"tier": "L1", "effort": "L1", "plan_first": "L1", "delegate_explore": "L1"}
    assert labels["tier"]["idx"] == 2


def test_human_records_are_not_mistaken_for_judge_failures(tmp_path):
    from agento_train.export import from_agento_judge

    line = json.loads(human_line("a", "opus", "high", plan=True, delegate=True))
    assert from_agento_judge(line) == line  # passes through untouched: no l1 view is invented from it
