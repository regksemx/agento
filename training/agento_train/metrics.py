"""Metrics for the router: classification quality, calibration, and the agento-specific cost/risk numbers (spec section 6).

Pure numpy, no torch: unit-tested on synthetic records. Everything here works on "prediction rows"

    {"id", "split", "probs": {head: [..]}, "logits": {head: [..]}, "meta": {labels, weights, obs_tier, cost, rules, l0, ...}}

written by teacher.py and distill.py (no prompt text in them).

Cost model (`reprice`), explicit on purpose. A task has one observed cost `C` (USD, API-equivalent, all calls) on its
observed model tier `o`. If the router had put it on tier `p` instead, the repriced cost is

    C' = C * (1 - s * (1 - r(o -> p))),      r(o -> p) = PRICE[p] / PRICE[o]

`PRICE` is the output list price per MTok. Input and cache-write list prices have the same ratios between tiers
(opus -> sonnet 0.5, sonnet -> haiku 0.5, opus -> haiku 0.25, fable -> opus 0.4), but a cache READ costs the same on Opus
and Sonnet ($0.20/MTok), and reads dominate a long agent run. So `s` is the share of the task cost that scales with the
price ratio: s = 1.0 is the list-price upper bound, s = 0.5 the conservative variant (only output + cache write + fresh
input scale). Both are reported; neither models effort (we do not know how many tokens a lower effort would save).

An accepted recommendation (confidence >= threshold) changes the tier; a rejected one keeps what the user chose, at cost C.
`savings_net_rerun` charges every under-routed accepted task (recommended cheaper than its label) one extra run on the
original tier: C' + C.
"""
from __future__ import annotations

import math
from typing import Any, Optional, Sequence

import numpy as np

from .questions import EFFORTS, HEAD_SIZES, HEADS, TIERS

# Output list price, USD per MTok (Anthropic list prices, checked 2026-10-05).
PRICE_OUT = {"haiku": 5.0, "sonnet": 10.0, "opus": 20.0, "fable": 50.0}
COST_SCALE = {"upper": 1.0, "conservative": 0.5}
UNDER_ALPHA = 0.05  # spec section 6: under-routing <= 5% ...
UNDER_DELTA = 0.05  # ... with 95% confidence (Clopper-Pearson upper bound)
MIN_ACCEPTED = 10


# ───────────────────────────────────────────── classification ─────────────────────────────────────────────


def softmax(z: Any, temperature: float = 1.0) -> np.ndarray:
    z = np.asarray(z, dtype=np.float64) / float(temperature)
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def accuracy(y: np.ndarray, pred: np.ndarray) -> float:
    return float((np.asarray(y) == np.asarray(pred)).mean()) if len(y) else float("nan")


def macro_f1(y: np.ndarray, pred: np.ndarray, k: int) -> float:
    """Macro F1 over the classes that occur in `y` or `pred` (a class that never occurs does not count as F1 = 0)."""
    y, pred = np.asarray(y), np.asarray(pred)
    f1s = []
    for c in range(k):
        tp = int(((y == c) & (pred == c)).sum())
        fp = int(((y != c) & (pred == c)).sum())
        fn = int(((y == c) & (pred != c)).sum())
        if tp + fp + fn == 0:
            continue
        f1s.append(2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f1s)) if f1s else float("nan")


def ece(conf: np.ndarray, correct: np.ndarray, bins: int = 15) -> float:
    """Expected calibration error, equal-width bins, same convention as `laya.common.ece_score`."""
    conf, correct = np.asarray(conf, dtype=float), np.asarray(correct, dtype=float)
    if len(conf) == 0:
        return float("nan")
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        sel = (conf >= lo if i == 0 else conf > lo) & (conf <= hi)
        if sel.any():
            total += sel.mean() * abs(conf[sel].mean() - correct[sel].mean())
    return float(total)


def brier(probs: np.ndarray, y: np.ndarray) -> float:
    """Multi-class Brier score: mean over samples of sum_k (p_k - 1[y = k])^2 (0 is perfect, 2 the worst)."""
    probs = np.asarray(probs, dtype=float)
    onehot = np.eye(probs.shape[1])[np.asarray(y, dtype=int)]
    return float(((probs - onehot) ** 2).sum(axis=1).mean()) if len(probs) else float("nan")


def aurc(conf: np.ndarray, correct: np.ndarray) -> float:
    """Area under the risk-coverage curve (lower is better). Tied confidences enter together, so order does not matter."""
    conf, correct = np.asarray(conf, dtype=float), np.asarray(correct, dtype=float)
    n = len(conf)
    if n == 0:
        return float("nan")
    order = np.argsort(-conf, kind="stable")
    c, ok = conf[order], correct[order]
    cum_err = np.cumsum(1.0 - ok)
    risks = []
    i = 0
    while i < n:
        j = i
        while j + 1 < n and c[j + 1] == c[i]:
            j += 1
        risks.extend([cum_err[j] / (j + 1)] * (j - i + 1))  # every member of a tie group sees the group-end risk
        i = j + 1
    return float(np.mean(risks))


def head_metrics(probs: np.ndarray, y: np.ndarray) -> dict:
    probs = np.asarray(probs, dtype=float)
    y = np.asarray(y, dtype=int)
    pred = probs.argmax(axis=1)
    conf = probs.max(axis=1)
    correct = (pred == y).astype(float)
    return {
        "n": int(len(y)),
        "accuracy": accuracy(y, pred),
        "macro_f1": macro_f1(y, pred, probs.shape[1]),
        "ece": ece(conf, correct),
        "brier": brier(probs, y),
        "aurc": aurc(conf, correct),
        "mean_conf": float(conf.mean()) if len(conf) else float("nan"),
    }


def fit_temperature(logits: np.ndarray, targets: np.ndarray, lo: float = 0.25, hi: float = 8.0) -> float:
    """The scalar T minimising the soft NLL of softmax(logits / T) against `targets` (golden-section on log T)."""
    logits = np.asarray(logits, dtype=np.float64)
    targets = np.asarray(targets, dtype=np.float64)
    if len(logits) < 10:
        return 1.0

    def nll(log_t: float) -> float:
        z = logits / math.exp(log_t)
        z = z - z.max(axis=1, keepdims=True)
        logp = z - np.log(np.exp(z).sum(axis=1, keepdims=True))
        return float(-(targets * logp).sum(axis=1).mean())

    a, b = math.log(lo), math.log(hi)
    g = (math.sqrt(5) - 1) / 2
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = nll(c), nll(d)
    for _ in range(60):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = nll(c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = nll(d)
    return float(math.exp((a + b) / 2))


# ───────────────────────────────────────────── risk bound ─────────────────────────────────────────────


def _binom_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k) for X ~ Binomial(n, p), summed in log space (n up to a few thousand)."""
    if p <= 0.0:
        return 1.0
    if p >= 1.0:
        return 1.0 if k >= n else 0.0
    lp, lq = math.log(p), math.log1p(-p)
    logs = [math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq for i in range(k + 1)]
    m = max(logs)
    return min(1.0, math.exp(m) * sum(math.exp(x - m) for x in logs))


def clopper_pearson_upper(k: int, n: int, delta: float = UNDER_DELTA) -> float:
    """One-sided upper (1 - delta) Clopper-Pearson bound on a rate seen as k events in n trials."""
    if n <= 0:
        return 1.0
    if k >= n:
        return 1.0
    lo, hi = k / n, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if _binom_cdf(k, n, mid) > delta:
            lo = mid
        else:
            hi = mid
    return hi


def fit_underroute_threshold(conf: np.ndarray, under: np.ndarray, alpha: float = UNDER_ALPHA, delta: float = UNDER_DELTA,
                             min_accepted: int = MIN_ACCEPTED) -> dict:
    """The smallest confidence tau whose accepted set {conf >= tau} has a Clopper-Pearson under-routing bound <= alpha.

    Fit on the CALIBRATION split only; the test split then shows what that threshold really does. `under[i]` is 1 when
    the recommendation for task i is cheaper than its label. Returns `threshold = None` when no cut keeps the risk (the
    router then never acts on its own: savings 0, risk 0), and `1.01` is what callers should compare against.
    """
    conf, under = np.asarray(conf, dtype=float), np.asarray(under, dtype=int)
    best = None
    for tau in sorted(set(conf.tolist()), reverse=True):
        sel = conf >= tau
        n = int(sel.sum())
        if n < min_accepted:
            continue
        k = int(under[sel].sum())
        ub = clopper_pearson_upper(k, n, delta)
        if ub <= alpha:
            best = {"threshold": float(tau), "accepted": n, "under": k, "cp_upper": ub, "coverage": n / len(conf)}
    if best is None:
        return {"threshold": None, "accepted": 0, "under": 0, "cp_upper": None, "coverage": 0.0, "alpha": alpha, "delta": delta}
    best.update({"alpha": alpha, "delta": delta})
    return best


# ───────────────────────────────────────────── cost and risk ─────────────────────────────────────────────


def price_ratio(obs_tier: str, pred_tier: str) -> float:
    """r(o -> p): output list price of the predicted tier over the observed one; 1.0 when either is unknown."""
    o, p = PRICE_OUT.get(obs_tier), PRICE_OUT.get(pred_tier)
    return p / o if o and p else 1.0


def reprice(cost: float, obs_tier: str, pred_tier: str, scale: float) -> float:
    """C' = C * (1 - s * (1 - r)). See the module docstring."""
    return cost * (1.0 - scale * (1.0 - price_ratio(obs_tier, pred_tier)))


def _arrays(rows: Sequence[dict]) -> dict:
    m = [r["meta"] for r in rows]
    return {
        "y_tier": np.array([x["labels"]["tier"] for x in m], dtype=int),
        "y_eff": np.array([x["labels"]["effort"] for x in m], dtype=int),
        "obs": [x.get("obs_tier", "unknown") for x in m],
        "cost": np.array([x.get("cost", 0.0) for x in m], dtype=float),
    }


def policy_report(rows: Sequence[dict], pred_tier: np.ndarray, pred_eff: np.ndarray,
                  accepted: Optional[np.ndarray] = None) -> dict:
    """Under/over-routing and savings of a policy that recommends `(pred_tier, pred_eff)` for every row.

    `accepted[i]` False means the recommendation is not applied (abstain): that task keeps the user's choice at its
    observed cost and counts neither as saving nor as risk. `accepted=None` accepts all.
    Rates are over the accepted tasks; `*_all` rates use all tasks as the denominator.
    """
    a = _arrays(rows)
    n = len(rows)
    pred_tier, pred_eff = np.asarray(pred_tier, dtype=int), np.asarray(pred_eff, dtype=int)
    acc = np.ones(n, dtype=bool) if accepted is None else np.asarray(accepted, dtype=bool)
    na = int(acc.sum())
    under_t = pred_tier < a["y_tier"]
    over_t = pred_tier > a["y_tier"]
    under_e = pred_eff < a["y_eff"]
    over_e = pred_eff > a["y_eff"]
    under_c = under_t | ((pred_tier == a["y_tier"]) & under_e)
    over_c = over_t | ((pred_tier == a["y_tier"]) & over_e)

    def rate(flag: np.ndarray) -> float:
        return float((flag & acc).sum() / na) if na else 0.0

    def rate_all(flag: np.ndarray) -> float:
        return float((flag & acc).sum() / n) if n else 0.0

    total = float(a["cost"].sum())
    out: dict[str, Any] = {
        "n": n,
        "accepted": na,
        "coverage": na / n if n else 0.0,
        "tier_acc": float(((pred_tier == a["y_tier"]) & acc).sum() / na) if na else float("nan"),
        "effort_acc": float(((pred_eff == a["y_eff"]) & acc).sum() / na) if na else float("nan"),
        "under_tier": rate(under_t),
        "over_tier": rate(over_t),
        "under_effort": rate(under_e),
        "over_effort": rate(over_e),
        "under_config": rate(under_c),
        "over_config": rate(over_c),
        "under_tier_all": rate_all(under_t),
        "over_tier_all": rate_all(over_t),
        "under_tier_cp_upper": clopper_pearson_upper(int((under_t & acc).sum()), na) if na else None,
        "cost_total": total,
    }
    for name, s in COST_SCALE.items():
        repriced = 0.0
        rerun = 0.0
        for i in range(n):
            c, o = a["cost"][i], a["obs"][i]
            if acc[i]:
                cp = reprice(c, o, TIERS[pred_tier[i]], s)
                repriced += cp
                rerun += cp + (c if under_t[i] else 0.0)
            else:
                repriced += c
                rerun += c
        out["savings_" + name] = (1.0 - repriced / total) if total > 0 else 0.0
        out["savings_net_rerun_" + name] = (1.0 - rerun / total) if total > 0 else 0.0
    return out


def threshold_curve(rows: Sequence[dict], pred_tier: np.ndarray, pred_eff: np.ndarray, conf: np.ndarray,
                    grid: Sequence[float] = (0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95)) -> list[dict]:
    """policy_report at each confidence cut: how coverage, under-routing and savings trade off."""
    curve = []
    for t in grid:
        rep = policy_report(rows, pred_tier, pred_eff, np.asarray(conf) >= t)
        curve.append({"threshold": t, **{k: rep[k] for k in ("coverage", "under_tier", "over_tier", "tier_acc",
                                                              "savings_upper", "savings_conservative",
                                                              "savings_net_rerun_conservative")}})
    return curve


# ───────────────────────────────────────────── evaluation of prediction rows ─────────────────────────────────────────────


def _head_arrays(rows: Sequence[dict], head: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """probs, labels, weights for the rows that carry a label for `head`."""
    sel = [r for r in rows if head in r["meta"]["labels"]]
    if not sel:
        return np.zeros((0, HEAD_SIZES[head])), np.zeros(0, dtype=int), np.zeros(0)
    probs = np.array([r["probs"][head] for r in sel], dtype=float)
    y = np.array([r["meta"]["labels"][head] for r in sel], dtype=int)
    w = np.array([r["meta"]["weights"][head] for r in sel], dtype=float)
    return probs, y, w


def evaluate_rows(rows: Sequence[dict], threshold: Optional[float] = None) -> dict:
    """Everything the report needs for one model on one set of prediction rows.

    `threshold` is the tier-confidence cut fitted on the calibration split (None: no gated numbers).
    """
    out: dict[str, Any] = {"n": len(rows), "heads": {}}
    if not rows:
        return out
    for head in HEADS:
        probs, y, _ = _head_arrays(rows, head)
        if len(y):
            out["heads"][head] = head_metrics(probs, y)
    pt = np.array([int(np.argmax(r["probs"]["tier"])) for r in rows])
    pe = np.array([int(np.argmax(r["probs"]["effort"])) for r in rows])
    conf = np.array([float(np.max(r["probs"]["tier"])) for r in rows])
    out["policy"] = policy_report(rows, pt, pe)
    out["curve"] = threshold_curve(rows, pt, pe, conf)
    if threshold is not None:
        out["gated"] = policy_report(rows, pt, pe, conf >= threshold)
        out["gated"]["threshold"] = threshold
    out["by_source"] = _count(r["meta"]["sources"].get("tier", "?") for r in rows)
    return out


def _count(items) -> dict:
    d: dict[str, int] = {}
    for x in items:
        d[x] = d.get(x, 0) + 1
    return d


def per_project(rows: Sequence[dict], threshold: Optional[float] = None, min_n: int = 5) -> dict:
    """Tier accuracy, under/over-routing and savings per project (the per-project holdout view)."""
    by: dict[str, list[dict]] = {}
    for r in rows:
        by.setdefault(r["meta"].get("project") or "?", []).append(r)
    out = {}
    for proj, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        if len(rs) < min_n:
            continue
        ev = evaluate_rows(rs, threshold)
        pol = ev["policy"]
        out[proj] = {"n": len(rs), "tier_acc": pol["tier_acc"], "under_tier": pol["under_tier"],
                     "over_tier": pol["over_tier"], "savings_conservative": pol["savings_conservative"]}
    return out


# ───────────────────────────────────────────── baselines ─────────────────────────────────────────────


def baseline_predictions(rows: Sequence[dict], train_rows: Sequence[dict] = ()) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Fixed policies to compare the model against: `{name: (pred_tier, pred_effort)}` as index arrays.

    always-opus (opus, high), always-sonnet (sonnet, medium), rules v1 (the `rulesVerdict` stored at dataset build),
    L0 (the weak trajectory labeler; trivially perfect while the labels ARE L0, informative once L1/L2 labels exist) and
    the majority class of the train split.
    """
    n = len(rows)
    t_opus, t_sonnet = TIERS.index("opus"), TIERS.index("sonnet")
    out: dict[str, tuple[np.ndarray, np.ndarray]] = {
        "always-opus": (np.full(n, t_opus), np.full(n, EFFORTS.index("high"))),
        "always-sonnet": (np.full(n, t_sonnet), np.full(n, EFFORTS.index("medium"))),
    }

    def pick(getter, options, default):
        return np.array([options.index(getter(r)) if getter(r) in options else default for r in rows])

    out["rules-v1"] = (pick(lambda r: r["meta"]["rules"].get("tier"), TIERS, t_sonnet),
                       pick(lambda r: r["meta"]["rules"].get("effort"), EFFORTS, 1))
    out["L0"] = (pick(lambda r: r["meta"]["l0"].get("tier"), TIERS, t_sonnet),
                 pick(lambda r: r["meta"]["l0"].get("effort"), EFFORTS, 1))
    if train_rows:
        mt = np.bincount([r["meta"]["labels"]["tier"] for r in train_rows], minlength=3).argmax()
        me = np.bincount([r["meta"]["labels"]["effort"] for r in train_rows], minlength=3).argmax()
        out["majority"] = (np.full(n, mt), np.full(n, me))
    return out


def evaluate_baselines(rows: Sequence[dict], train_rows: Sequence[dict] = ()) -> dict:
    res = {}
    for name, (pt, pe) in baseline_predictions(rows, train_rows).items():
        pol = policy_report(rows, pt, pe)
        tier_probs = np.eye(3)[pt]
        eff_probs = np.eye(3)[pe]
        y_t = np.array([r["meta"]["labels"]["tier"] for r in rows])
        y_e = np.array([r["meta"]["labels"]["effort"] for r in rows])
        res[name] = {
            **pol,
            "tier_macro_f1": macro_f1(y_t, pt, 3),
            "effort_macro_f1": macro_f1(y_e, pe, 3),
            "tier_brier": brier(tier_probs, y_t),
            "effort_brier": brier(eff_probs, y_e),
        }
    return res


def thresholds_from_calibration(rows: Sequence[dict], alpha: float = UNDER_ALPHA, delta: float = UNDER_DELTA,
                                head: str = "tier") -> dict:
    """Fit the confidence threshold of `head` (tier or effort) on calibration rows (see `fit_underroute_threshold`).

    "Under" is a recommendation cheaper than the label: a lower tier, or a lower effort level.
    """
    if not rows:
        return {"threshold": None, "accepted": 0, "under": 0, "cp_upper": None, "coverage": 0.0}
    y = np.array([r["meta"]["labels"][head] for r in rows], dtype=int)
    pred = np.array([int(np.argmax(r["probs"][head])) for r in rows])
    conf = np.array([float(np.max(r["probs"][head])) for r in rows])
    return fit_underroute_threshold(conf, (pred < y).astype(int), alpha, delta)


def to_jsonable(o: Any) -> Any:
    """numpy scalars/arrays -> Python, NaN/inf -> None, so `json.dump` writes strict JSON."""
    if isinstance(o, dict):
        return {str(k): to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [to_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return to_jsonable(o.tolist())
    if isinstance(o, np.generic):
        return to_jsonable(o.item())
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def effective_threshold(fit: dict) -> float:
    """The cut to apply: the fitted one, or 1.01 (never act) when no cut keeps the under-routing risk."""
    return fit["threshold"] if fit.get("threshold") is not None else 1.01
