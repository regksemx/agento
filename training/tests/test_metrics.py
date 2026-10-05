"""Metrics on synthetic prediction rows: under/over-routing, savings, ECE, thresholds."""
import math

import numpy as np
import pytest

from agento_train import metrics as M


def row(label_tier, pred_tier, conf=0.9, obs="opus", cost=10.0, label_eff=1, pred_eff=1):
    probs_t = [0.0, 0.0, 0.0]
    rest = (1 - conf) / 2
    probs_t = [rest] * 3
    probs_t[pred_tier] = conf
    probs_e = [0.1, 0.1, 0.1]
    probs_e[pred_eff] = 0.8
    return {"id": "x", "split": "test", "probs": {"tier": probs_t, "effort": probs_e, "plan_first": [0.5, 0.5], "delegate_explore": [0.5, 0.5]},
            "meta": {"labels": {"tier": label_tier, "effort": label_eff, "plan_first": 0, "delegate_explore": 0},
                     "weights": {"tier": 1, "effort": 1, "plan_first": 1, "delegate_explore": 1}, "sources": {"tier": "L0"},
                     "obs_tier": obs, "cost": cost, "rules": {"tier": "opus", "effort": "high"}, "l0": {"tier": "opus", "effort": "high"},
                     "project": "p"}}


def test_ece_perfect_and_overconfident():
    assert M.ece(np.array([1.0, 1.0]), np.array([1.0, 1.0])) == 0.0
    assert M.ece(np.array([0.9] * 10), np.array([1.0] * 5 + [0.0] * 5)) == pytest.approx(0.4)
    assert math.isnan(M.ece(np.array([]), np.array([])))


def test_brier_macro_f1_aurc():
    p = np.array([[1.0, 0, 0], [0, 1.0, 0]])
    assert M.brier(p, np.array([0, 1])) == 0.0
    assert M.brier(p, np.array([1, 0])) == pytest.approx(2.0)
    assert M.macro_f1(np.array([0, 0, 1, 1]), np.array([0, 1, 1, 1]), 3) == pytest.approx((2 / 3 + 0.8) / 2)
    # confident-and-right first gives a lower AURC than confident-and-wrong first; ties do not depend on order
    assert M.aurc(np.array([0.9, 0.8, 0.7]), np.array([1, 1, 0])) < M.aurc(np.array([0.9, 0.8, 0.7]), np.array([0, 1, 1]))
    assert M.aurc(np.array([0.5, 0.5]), np.array([1, 0])) == M.aurc(np.array([0.5, 0.5]), np.array([0, 1]))


def test_under_over_routing_rates():
    rows = [row(2, 1), row(2, 2), row(1, 2), row(1, 0), row(0, 0)]  # under, ok, over, under, ok
    pol = M.policy_report(rows, [1, 2, 2, 0, 0], [1] * 5)
    assert pol["under_tier"] == pytest.approx(2 / 5) and pol["over_tier"] == pytest.approx(1 / 5) and pol["tier_acc"] == pytest.approx(2 / 5)


def test_effort_and_config_under_over():
    rows = [row(1, 1, label_eff=2, pred_eff=1), row(1, 2, label_eff=0, pred_eff=0), row(1, 1, label_eff=1, pred_eff=2)]
    pol = M.policy_report(rows, [1, 2, 1], [1, 0, 2])
    assert pol["under_effort"] == pytest.approx(1 / 3) and pol["over_effort"] == pytest.approx(1 / 3)
    assert pol["under_config"] == pytest.approx(1 / 3)  # same tier, lower effort; the over-tier row is not under
    assert pol["over_config"] == pytest.approx(2 / 3)


def test_price_ratios_and_reprice_formula():
    assert M.price_ratio("opus", "sonnet") == 0.5 and M.price_ratio("opus", "haiku") == 0.25
    assert M.price_ratio("fable", "opus") == pytest.approx(0.4) and M.price_ratio("unknown", "sonnet") == 1.0
    assert M.reprice(10.0, "opus", "sonnet", 1.0) == pytest.approx(5.0)
    assert M.reprice(10.0, "opus", "sonnet", 0.5) == pytest.approx(7.5)  # only half of the cost scales
    assert M.reprice(10.0, "sonnet", "opus", 1.0) == pytest.approx(20.0)  # going up costs more
    assert M.reprice(10.0, "opus", "opus", 1.0) == 10.0


def test_savings_total_and_net_of_reruns():
    rows = [row(1, 1, obs="opus", cost=10), row(2, 1, obs="opus", cost=10)]  # second is under-routed
    pol = M.policy_report(rows, [1, 1], [1, 1])
    assert pol["savings_upper"] == pytest.approx(0.5) and pol["savings_conservative"] == pytest.approx(0.25)
    # net: row1 5, row2 5 + 10 re-run = 20 of 20 -> 0 saved at list price
    assert pol["savings_net_rerun_upper"] == pytest.approx(0.0)
    assert pol["savings_net_rerun_conservative"] == pytest.approx(1 - (7.5 + 17.5) / 20)


def test_savings_at_threshold_only_accepted_tasks_move():
    rows = [row(1, 1, conf=0.95, cost=10), row(1, 1, conf=0.4, cost=30)]
    conf = np.array([0.95, 0.4])
    pol = M.policy_report(rows, [1, 1], [1, 1], conf >= 0.9)
    assert pol["accepted"] == 1 and pol["coverage"] == 0.5
    assert pol["savings_upper"] == pytest.approx(5 / 40)  # the 30 USD task keeps its observed cost
    assert M.policy_report(rows, [1, 1], [1, 1], np.zeros(2, bool))["savings_upper"] == 0.0


def test_baselines():
    rows = [row(0, 0, obs="opus", cost=8), row(2, 2, obs="sonnet", cost=2)]
    b = M.evaluate_baselines(rows, rows)
    assert b["always-opus"]["under_tier"] == 0.0 and b["always-opus"]["savings_upper"] == 0.0 or b["always-opus"]["savings_upper"] < 0
    assert b["always-sonnet"]["under_tier"] == pytest.approx(0.5)  # second row needs opus
    assert b["L0"]["tier_acc"] == pytest.approx(0.5) and "rules-v1" in b and "majority" in b


def test_clopper_pearson_known_values():
    assert M.clopper_pearson_upper(0, 10, 0.05) == pytest.approx(1 - 0.05 ** (1 / 10), abs=1e-6)
    assert M.clopper_pearson_upper(10, 10) == 1.0 and M.clopper_pearson_upper(0, 0) == 1.0
    assert M.clopper_pearson_upper(2, 50) < M.clopper_pearson_upper(5, 50)


def test_underroute_threshold_fit():
    rng = np.random.default_rng(0)
    conf = rng.uniform(0.4, 1.0, 600)
    under = (rng.uniform(size=600) < np.where(conf > 0.8, 0.01, 0.4)).astype(int)
    fit = M.fit_underroute_threshold(conf, under)
    assert fit["threshold"] is not None and 0.7 < fit["threshold"] < 0.95 and fit["cp_upper"] <= 0.05
    # everything risky: no safe cut, never act
    bad = M.fit_underroute_threshold(conf, np.ones(600, int))
    assert bad["threshold"] is None and M.effective_threshold(bad) > 1.0
    # too few tasks to be sure
    assert M.fit_underroute_threshold(conf[:5], under[:5])["threshold"] is None


def test_temperature_fit_softens_overconfident_logits():
    rng = np.random.default_rng(1)
    y = rng.integers(0, 3, 400)
    logits = rng.normal(size=(400, 3)) * 3
    logits[np.arange(400), y] += 3.0 * (rng.uniform(size=400) < 0.5)  # right only half the time but loud
    t = M.fit_temperature(logits, np.eye(3)[y])
    assert t > 1.5
    p0, p1 = M.softmax(logits), M.softmax(logits, t)
    acc = (p1.argmax(1) == y).astype(float)
    assert M.ece(p1.max(1), acc) < M.ece(p0.max(1), acc)
    assert M.fit_temperature(logits[:3], np.eye(3)[y[:3]]) == 1.0


def test_evaluate_rows_and_thresholds_from_calibration():
    rows = [row(1, 1, conf=0.9), row(2, 2, conf=0.8), row(0, 1, conf=0.6), row(1, 1, conf=0.95)] * 25
    ev = M.evaluate_rows(rows, threshold=0.7)
    assert ev["n"] == 100 and ev["heads"]["tier"]["accuracy"] == pytest.approx(0.75)
    assert ev["gated"]["coverage"] == pytest.approx(0.75) and len(ev["curve"]) == 7
    fit = M.thresholds_from_calibration(rows)  # no under-routed row; 59+ accepted tasks are needed for a 5% bound at 95%
    assert fit["threshold"] is not None and fit["accepted"] >= 59 and M.thresholds_from_calibration(rows[:40])["threshold"] is None
    json_ready = M.to_jsonable({"a": np.float64("nan"), "b": np.array([1, 2]), "c": np.int64(3)})
    assert json_ready == {"a": None, "b": [1, 2], "c": 3}


def test_per_project_table():
    rows = [row(1, 1) for _ in range(6)]
    assert M.per_project(rows)["p"]["n"] == 6 and M.per_project(rows[:3]) == {}
