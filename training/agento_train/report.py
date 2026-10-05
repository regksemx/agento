"""`artifacts/<run-id>/report.md` + `metrics.json`: one page with the numbers that decide whether the router may act.

    python -m agento_train.report artifacts/<run-id>

Reads `data/splits.json`, `teacher/metrics.json`, `student/metrics.json`; writes the two files next to them.
No prompt text goes into either file.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Optional

from .metrics import to_jsonable
from .questions import HEADS


def _f(x: Any, nd: int = 3) -> str:
    return "n/a" if x is None or (isinstance(x, float) and x != x) else ("%.*f" % (nd, x) if isinstance(x, (int, float)) else str(x))


def _pct(x: Any, nd: int = 1) -> str:
    return "n/a" if x is None or (isinstance(x, float) and x != x) else "%.*f%%" % (nd, 100 * x)


def table(headers: list[str], rows: list[list[Any]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def _load(p: Path) -> Optional[dict]:
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _policy_row(name: str, pol: dict) -> list[Any]:
    return [name, pol["n"] if "accepted" not in pol else pol["accepted"], _pct(pol.get("coverage")), _pct(pol.get("tier_acc")),
            _pct(pol.get("under_tier")), _pct(pol.get("over_tier")), _pct(pol.get("under_config")),
            _pct(pol.get("savings_upper")), _pct(pol.get("savings_conservative")), _pct(pol.get("savings_net_rerun_conservative"))]


POLICY_HEADERS = ["policy", "n acted", "coverage", "tier acc", "under-routing", "over-routing", "under (tier+effort)",
                  "savings (list price)", "savings (conservative)", "net of re-runs"]


def head_table(ev: dict) -> str:
    rows = []
    for h in HEADS:
        m = ev["heads"].get(h)
        if m:
            rows.append([h, m["n"], _pct(m["accuracy"]), _f(m["macro_f1"]), _f(m["ece"]), _f(m["brier"]), _f(m["aurc"]), _f(m["mean_conf"])])
    return table(["head", "n", "accuracy", "macro-F1", "ECE", "Brier", "AURC", "mean conf"], rows)


def policy_table(model_name: str, ev: dict, baselines: dict) -> str:
    rows = [_policy_row(model_name + " (every task)", ev["policy"])]
    if "gated" in ev:
        thr = ev["gated"]["threshold"]
        rows.append(_policy_row("%s @ tier conf >= %s" % (model_name, _f(thr, 2)), ev["gated"]))
    for name, b in baselines.items():
        rows.append(_policy_row(name, b))
    return table(POLICY_HEADERS, rows)


def curve_table(ev: dict) -> str:
    rows = [[_f(c["threshold"], 2), _pct(c["coverage"]), _pct(c["tier_acc"]), _pct(c["under_tier"]), _pct(c["over_tier"]),
             _pct(c["savings_upper"]), _pct(c["savings_conservative"]), _pct(c["savings_net_rerun_conservative"])] for c in ev["curve"]]
    return table(["tier conf >=", "coverage", "tier acc", "under-routing", "over-routing", "savings (list)", "savings (cons.)", "net of re-runs"], rows)


def build_report(root: Path, run_id: str, splits: Optional[dict] = None) -> tuple[str, dict]:
    splits = splits or _load(root / "data" / "splits.json") or {}
    t = _load(root / "teacher" / "metrics.json")
    s = _load(root / "student" / "metrics.json")
    combined: dict[str, Any] = {"run_id": run_id, "data": {k: splits.get(k) for k in ("counts", "labels", "sources", "span", "records", "skipped",
                                                                                         "judge_merged", "holdout_projects", "tokenizer", "max_state_tokens")},
                                "teacher": t, "student": s}
    L: list[str] = ["# agento router training report", "",
                    "> Run `%s`. Teacher: Laya fine-tuned with RLCD. Student: distilled encoder, ONNX for the daemon. "
                    "Every number below is on data the model did not train on and the thresholds did not see." % run_id, ""]

    # data
    L += ["## Data", ""]
    if splits:
        c = splits["counts"]
        L.append(table(["split", "tasks", "label sources", "tier mix", "effort mix"],
                       [[k, c[k], json.dumps(splits["sources"].get(k, {})), json.dumps(splits["labels"].get(k, {}).get("tier", {})),
                         json.dumps(splits["labels"].get(k, {}).get("effort", {}))] for k in c]))
        L += ["", "Split by time: the last 15% of tasks by start time are test, the 15% before them calibration, the rest train. "
              "`holdout` (if any) is whole projects kept out of everything.", ""]
        only_l0 = all(set(v) <= {"L0"} for v in splits["sources"].values())
        if only_l0:
            L += ["> **All labels are L0.** L0 measures how hard the task turned out to be, not that a cheaper model would have been enough "
                  "(spec section 2). \"Accuracy\" and \"under-routing\" below are agreement with that weak labeler. Treat them as "
                  "a pipeline check until L1/L2 labels exist.", ""]
        small = [k for k in ("calibration", "test") if c.get(k, 0) < 100]
        if small:
            L += ["> Small sample: %s has fewer than 100 tasks, so every rate carries wide error bars (see the Clopper-Pearson columns)." % ", ".join(small), ""]

    # teacher
    if t:
        ev = t["eval"]["test"]
        L += ["## Teacher (Laya, %s)" % t["checkpoint"], "",
              "Loop: %s; `laya.train` from the %s; %s epochs; device %s; weights: %s." % (t["loop"], t["laya_train"], t["train"]["epochs"], t["device"], t["train"]["weights"]),
              "Items truncated by the 1024-token window: %s of %s." % (t["train"]["truncated"], t["train"]["items"]), "",
              "### Test: per head", "", head_table(ev), ""]
        cal = t["calibration"]
        L += ["### Calibration (fitted on the calibration split only)", "",
              "- temperature per question type [choice, score, noul]: `%s`; bucket map: `%s`" % (cal["temperature"], cal["temperature_by_options"] or "none (buckets too small)"),
              "- `fit_abstention_thresholds` (target error %s): `%s`" % (cal["abstention_target_error"], cal["abstention_thresholds"] or "none (buckets under the minimum size)"),
              "- agento tier threshold (Clopper-Pearson upper bound of under-routing <= %s at %s): %s" % (
                  _pct(cal["tier_threshold"].get("alpha", 0.05)), _pct(1 - cal["tier_threshold"].get("delta", 0.05), 0),
                  ("**%s** (accepts %s of calibration tasks, %s under-routed, bound %s)" % (_f(cal["tier_threshold"]["threshold"], 3), _pct(cal["tier_threshold"]["coverage"]),
                                                                                         cal["tier_threshold"]["under"], _pct(cal["tier_threshold"]["cp_upper"]))
                   if cal["tier_threshold"]["threshold"] is not None else "**none**: no cut keeps the risk, the router would never act on its own")), ""]
        L += ["### Test: routing policy against baselines", "", policy_table("teacher", ev, t["baselines"]["test"]), ""]
        L += ["### Test: threshold sweep (teacher)", "", curve_table(ev), ""]
        if "holdout" in t["eval"]:
            L += ["### Project holdout (projects never seen in training)", "", head_table(t["eval"]["holdout"]), "",
                  policy_table("teacher", t["eval"]["holdout"], t["baselines"]["holdout"]), ""]
        pp = t["per_project"].get("test", {})
        if pp:
            L += ["### Test: per project", "", table(["project", "n", "tier acc", "under-routing", "over-routing", "savings (cons.)"],
                                                   [[k, v["n"], _pct(v["tier_acc"]), _pct(v["under_tier"]), _pct(v["over_tier"]), _pct(v["savings_conservative"])] for k, v in pp.items()]), ""]
        ins = t["eval"]["train_in_sample"]["heads"].get("tier")
        if ins:
            L += ["In-sample tier accuracy (train split): %s against %s on test; a large gap means overfitting." % (_pct(ins["accuracy"]), _pct(ev["heads"]["tier"]["accuracy"])), ""]
        rc = t.get("laya_runtime_check", {})
        L += ["`laya.load` check of the saved checkpoint: %s." % ("ok, max tier probability difference %s" % _f(rc.get("max_tier_prob_diff"), 4) if rc.get("ok") else "FAILED: %s" % rc.get("error")), ""]

    # student
    if s:
        ev = s["eval"]["test"]
        L += ["## Student (%s, %.0fM parameters)" % (s["student"], s["params_m"]), "",
              "KD on %s; alpha %s, tau %s; max_len %s." % ("calibrated teacher probabilities" if s["train"]["kd"] else "labels only (no teacher probabilities)", s["train"]["alpha"], s["train"]["tau"], s["max_len"]), "",
              "### Test: per head", "", head_table(ev), ""]
        vt = s.get("vs_teacher", {}).get("test")
        if vt:
            L += ["Argmax agreement with the teacher on test: **%s** (tier %s, effort %s, plan_first %s, delegate_explore %s); max probability difference %s." % (
                _pct(vt["agreement"]), _pct(vt["per_head"]["tier"]), _pct(vt["per_head"]["effort"]), _pct(vt["per_head"]["plan_first"]),
                _pct(vt["per_head"]["delegate_explore"]), _f(vt["max_prob_diff"])), ""]
        bl = (t or {}).get("baselines", {}).get("test", {})
        L += ["### Test: routing policy", "", policy_table("student", ev, bl), ""]
        L += ["### Test: threshold sweep (student)", "", curve_table(ev), ""]
        sc = s["calibration"]
        L += ["Temperatures (calibration split): `%s`. Tier threshold: %s; effort threshold: %s." % (
            {k: round(v, 3) for k, v in sc["temperature"].items()}, _f(sc["tier_threshold"]["threshold"]), _f(sc["effort_threshold"]["threshold"])), ""]
        fp = s["onnx_fp32"]
        par, lat = fp["parity"], fp["latency"]
        L += ["### ONNX and latency", "",
              table(["artifact", "check", "result"], [
                  ["fp32 (opset %s)" % fp["opset"], "argmax agreement with torch (need >= %s)" % _pct(par["threshold"], 0), "%s on %s texts: %s" % (_pct(par["agreement"], 2), par["n"], "OK" if par["ok"] else "FAIL")],
                  ["fp32", "max probability difference / max logit difference", "%.1e / %.1e" % (par["max_prob_diff"], par["max_logit_diff"])],
                  ["fp32", "CPU latency, batch 1, seq %s, %s threads (ORT %s)" % (lat["seq_len"], lat["threads"], lat["onnxruntime"]), "p50 **%.1f ms**, p95 %.1f ms, %s MB" % (lat["p50_ms"], lat["p95_ms"], lat["file_mb"])],
                  ["fp32", "CPU latency, batch 1, seq %s (a typical prompt)" % fp["latency_short"]["seq_len"], "p50 **%.1f ms**, p95 %.1f ms" % (fp["latency_short"]["p50_ms"], fp["latency_short"]["p95_ms"])],
              ]), ""]
        i8 = s.get("onnx_int8", {})
        if i8.get("kept"):
            l8 = i8["latency"]
            L += ["INT8 (static, QDQ): **kept**. Agreement with fp32 %s, ECE %s -> %s (delta %+.4f), p50 %.1f ms, p95 %.1f ms, %s MB." % (
                _pct(i8["agreement"], 2), _f(i8["ece_fp32"], 4), _f(i8["ece_int8"], 4), i8["ece_delta"], l8["p50_ms"], l8["p95_ms"], l8["file_mb"]), ""]
        elif "agreement" in i8:
            L += ["INT8 (static, QDQ): **discarded**, %s (agreement %s, ECE delta %+.4f). The fp32 model is the one packaged." % (i8["reason"], _pct(i8["agreement"], 2), i8["ece_delta"]), ""]
        else:
            L += ["INT8: **not produced** (%s)." % i8.get("reason", "n/a"), ""]
        pk, bc = s.get("packaged", {}), s.get("brain_check", {})
        L += ["Packaged for the daemon: `%s` (`%s`, sha256 `%s...`). `agento-brain check`: %s." % (
            pk.get("dir"), pk.get("onnx"), (pk.get("sha256") or "")[:12], {True: "ok", False: "FAILED", None: "skipped"}[bc.get("ok")]), ""]

    L += ["## Cost model", "",
          "Repriced cost of a task moved from its observed tier `o` to the recommended tier `p`: `C' = C * (1 - s * (1 - r))`, `r = price_out[p] / price_out[o]` "
          "(haiku 5, sonnet 10, opus 20, fable 50 USD/MTok). `s = 1` is the list-price upper bound; `s = 0.5` is the conservative variant, because cache reads cost the same on Opus "
          "and Sonnet and dominate long agent runs. A recommendation below the confidence threshold is not applied (cost unchanged). "
          "\"Net of re-runs\" charges every under-routed task one extra run on its original tier. Effort is not priced.", ""]
    return "\n".join(L), combined


def write_report(root: Path, run_id: Optional[str] = None, splits: Optional[dict] = None, log=print) -> None:
    run_id = run_id or root.name
    md, combined = build_report(root, run_id, splits)
    (root / "report.md").write_text(md + "\n", encoding="utf-8")
    (root / "metrics.json").write_text(json.dumps(to_jsonable(combined), indent=2), encoding="utf-8")
    log("report: wrote %s and %s" % (root / "report.md", root / "metrics.json"))


def main(argv: Optional[list[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: python -m agento_train.report artifacts/<run-id>", file=sys.stderr)
        return 2
    write_report(Path(argv[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
