# Public data: TwinRouterBench

Why: replays (L2) on the owner's own history turned out impractical (6 of 581 tasks replayable, about $20 per run). TwinRouterBench
(https://github.com/CommonstackAI/TwinRouterBench, paper https://arxiv.org/abs/2605.18859, **Apache-2.0**, `LICENSE` in the repository root,
dataset mirror https://huggingface.co/datasets/Amorph/TwinRouterBench) ships ~970 router-visible step prefixes with execution-verified minimum
tiers. We use it (a) as public training data for the general model and (b) to **validate the L1 judge
for free**: judge predictions against verified tiers (`agento dataset validate-judge`).

Inspected: commit `7cbb0deac8` (shallow clone, 2026-10-05).

## Files and format

Only `data/static/` matters for us (the static track):

| File | Content |
|---|---|
| `data/static/question_bank.jsonl` | 970 lines, 17 MB: the labelled steps |
| `data/static/manifest.json` | line counts per source workload; `no_model_ids_in_records: true` (a record never names the model that passed) |
| `data/dynamic/*.json` | the dynamic track (live SWE runs): model pool, pricing, `tier_to_model.json`, and `dynamic_heldout100_ids.txt` (100 SWE-bench Verified ids) |
| `twinrouterbench/data_generation/model_pool_v2.json` | the model pool of the static labels (see tiers below) |
| `docs/DATA_GENERATION.md` | construction protocol |

One `question_bank.jsonl` row is one routed **step** of an agent trajectory:

```jsonc
{
  "id": "swebench_django__django-11163_step_1",   // unique across the file
  "benchmark": "swebench",                        // swebench | bfcl | mtrag | qmsum | pinchbench
  "scenario": "code_swe",                         // code_swe | bfcl_tool_use_multi_turn | rag_multiturn | meeting_query_summarization | general_agent
  "instance_id": "django__django-11163",          // the trajectory
  "step_index": 1, "total_steps": 9,
  "messages": [ {"role": "system|user|assistant|tool", "content": "..." | [{"type":"text","text":"..."}] | null,
                 "tool_calls": [...], "reasoning": "..."} ],   // OpenAI chat format: the router-visible prefix
  "functions": [ ... ],                           // bfcl only: tool definitions
  "target_tier": "low", "target_tier_id": 0,      // the label
  "benchmark_display", "benchmark_subset"?, "benchmark_version", "pipeline_stage", "collector", "collected_at", "notes"?
}
```

`messages` is everything the model sees for the call that comes next (system prompt, user turns, earlier assistant turns with `tool_calls`, tool
results). The label is the cheapest tier that passed for **that** call. `pipeline_stage` says how solid the label is.

### Splits

There is **no train/test split** in the static file. The paper's only fixed split is the dynamic held-out set: 100 SWE-bench Verified instances
(`dynamic_heldout100_ids.txt`), disjoint from the 40 SWE instances of the static bank (checked: 0 overlap). For our own experiments split **by
`instance_id`** (a trajectory), never by row: steps of one trajectory share a prefix.

## Tiers

Four tiers, `low < mid < mid_high < high` (ids 0..3). Pool (`model_pool_v2.json`, `version: twinrouterbench-static-v2-paper-2026-05-08`):

| Tier | Models |
|---|---|
| low | DeepSeek-V3.2, GLM-4.5-Air, Qwen3.5-9B |
| mid | MiniMax-M2.5, Qwen3.5-27B, Qwen3-Coder |
| mid_high | **Claude Haiku 4.5**, Gemini 3 Flash, Qwen3.5-397B-A17B |
| high | **Claude Opus 4.6**, GPT-5.4 |

Protocol (`docs/DATA_GENERATION.md`): a strong-model seed trajectory that solved the task; a conservative downgrade hint per step (a pruning device,
never a label by itself); **sequential locking** (steps already settled keep their tier, the current step tries a cheaper tier, all future steps stay at
`high`); the whole mixed-model trajectory is executed and a candidate is accepted only if the task passes **and the step count is unchanged**; a tier
passes when **at least one** pool model of that tier passes; later prefixes are rebuilt from the successful mixed trajectory; mtRAG and QMSum also need
a hardened faithfulness/completeness judge; about 10% of BFCL, SWE and PinchBench steps got a manual review (`tight` keeps the tier,
`further_downgradeable` lowers it by one).

### Mapping to agento tiers

| TwinRouterBench | agento | Why |
|---|---|---|
| `low` | `haiku` | the models are weaker than Haiku 4.5, so a step they pass is within Haiku's reach |
| `mid` | `haiku` | same: Qwen/MiniMax-class, still below Haiku 4.5, which sits one tier higher |
| `mid_high` | `sonnet` | Haiku 4.5 is in this tier, but only **one** of three models has to pass, so "Haiku suffices" is not established; the conservative reading is the next Claude tier |
| `high` | `opus` | the frontier class (Opus 4.6 / GPT-5.4): nothing cheaper was verified to pass |

The mapping lives in `cli/src/dataset/public/tier.ts` (`TIER_MAP`). Records keep the original tier (`l2Evidence.publicTier`, `publicTierId`), so the
mapping can be changed without re-importing. We have no effort axis here: `l2Effort` is absent (a verified tier is not a `tier·effort` pair).

## Caveats

- **Steps, not tasks.** The label is for one model call given its prefix. Our L1 judge normally reads a whole finished Claude Code task. On public
  records it sees only the prefix (no trajectory: the prompt says "No trajectory available; judge from the prefix only"). The validation therefore
  measures a harder, different question than L1 on the owner's tasks and is a **lower bound**.
- **`high` means "no cheaper tier was verified", not "proven necessary".** Sequential locking keeps future steps at `high`, and downgrade hints are
  conservative. Mid-trajectory SWE steps that are trivial (a `sed` that reads a function) are labelled `high` in the data. Under-routing against an
  `opus` label is therefore partly an artifact of the protocol; read the SWE numbers with that in mind. Likewise `high` was verified with Opus 4.6 or
  GPT-5.4, and a Claude Sonnet of a newer generation may well pass such a step.
- **Weak SWE labels.** 336 SWE rows have `pipeline_stage: degradation_search_done` and the `notes` field says "not marked ground_truth_ready ... Treat
  the dataset as degradation_search_done / weak-label routing supervision" (25 hard counterexample fixes were confirmed by formal validation). The
  other stages: `ground_truth_ready` (586: BFCL, mtRAG, QMSum), `mixed_model_validated` (48: PinchBench). We keep the stage in `l2Evidence.pipelineStage`.
- **Non-Claude models define the lower tiers.** `low` and `mid` are open-weight models; only `mid_high` (Haiku 4.5) and `high` (Opus 4.6) contain Claude.
  Records never say which model passed. Opus 4.6 and Haiku 4.5 are older than the Claude 5.x family we route between.
- **Domain mix** (after mapping; the real import below). Most steps are easy (77% haiku), and the only workload with a real spread of tiers is
  SWE-bench (336 steps, 40 trajectories: 127 / 41 / 168). BFCL (248), mtRAG (193) and QMSum (145) are almost all `low`; PinchBench (48, 12 trajectories)
  is the only general-agent workload. None is Claude Code, none is Russian, no tool set like ours. Accuracy against these labels is dominated by the
  `haiku` class (always answering `haiku` scores 77%): look at under-routing and saving, per workload.
- **Truncation.** A prefix is rendered to text and cut in the middle to about 6000 chars (the median full prefix is 7.3k chars, the maximum 71k, 716 of
  970 are cut). The head (system prompt, task) and the tail (latest steps) survive; long tool outputs lose their middle first (per-message caps).
- **License.** Apache-2.0 requires keeping the license and attribution. The import writes a `notice` line into `twinrouterbench.summary.json`; do not
  republish converted data without it and without the LICENSE text. We do not vendor their data into this repository.

## Using it

```
agento dataset import twinrouterbench --fetch                      # clone into $AGENTO_HOME/cache/twinrouterbench, convert
agento dataset import twinrouterbench --source <checkout|question_bank.jsonl|git-url> [--out <file>]
agento dataset judge --tasks $AGENTO_HOME/dataset/public/twinrouterbench.jsonl --backend ... --model ...
agento dataset validate-judge --judge $AGENTO_HOME/dataset/judge/<backend>-<model>.jsonl [--labels <public.jsonl>] [--threshold 0.7] [--benchmark swebench] [--max-under 0.05] [--out <json>]
```

Record format and metrics: `docs/dataset-schema.md` (sections "Public data" and "validate-judge"). The sweep over thresholds 0.5..0.9 (under-routing
against saving) is what decides the default judge threshold; run it per workload (`--benchmark swebench`) as well as overall.
