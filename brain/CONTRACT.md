# Model artifact contract (v1)

What `agento-brain` loads and what the training pipeline (`training/`, T35) must emit. Enforced at load by
`src/agento_brain/contract.py`; run `agento-brain check <model_dir>` to validate a directory without serving it.
All problems are reported at once; an invalid explicit `--model-dir` makes `serve` exit 2 (it never silently
falls back to rules).

## Directory

```
<model_dir>/
  model.onnx        # ONNX graph, CPU, fp32 or correctly quantized (agreement/ECE re-checked by training)
  tokenizer.json    # HuggingFace `tokenizers` fast-tokenizer file (special tokens / post-processor included)
  heads.json        # labels, max_len, temperatures, thresholds, input_template
  meta.json         # run id + metrics summary
```

## model.onnx interface

| | |
|---|---|
| inputs | `input_ids` int64 `[batch, seq]`, `attention_mask` int64 `[batch, seq]`; optional `token_type_ids` (fed zeros). No other inputs. Dynamic `seq`. |
| outputs | one **raw logits** output per head, named `logits_<head>`, float `[batch, n_labels]` (binary heads: 2 logits, index 1 = yes). Extra outputs are ignored. |
| inference | batch size 1, no padding. Truncation is done by the daemon (below), so the graph must accept any `seq <= max_len`. |

Softmax and temperature are applied by the daemon: `p = softmax(logits / temperatures[head])`.

## heads.json

```json
{
  "heads": {
    "tier":             ["haiku", "sonnet", "opus"],
    "effort":           ["low", "medium", "high"],
    "plan_first":       ["no", "yes"],
    "delegate_explore": ["no", "yes"]
  },
  "max_len": 512,
  "temperatures": {"tier": 1.1, "effort": 0.9, "plan_first": 1.0, "delegate_explore": 1.0},
  "thresholds": {
    "abstain": {"tier": 0.55, "effort": 0.5},
    "yes":     {"plan_first": 0.5, "delegate_explore": 0.5}
  },
  "input_template": "[lang={lang}][repo={repo}][ctx={ctx}][files_in_repo={files_in_repo}][start={start}]\n[prev_task={prev_task}][git_dirty={git_dirty}][mentions={mentions}]\n{text}",
  "head_frac": 0.75
}
```

Rules (violations -> `ContractError`):

- `heads`: the four required heads must exist. Extra heads are allowed (e.g. `new_task`) and become valid `/v1/systemone` question names. Labels: unique, >= 2.
  `tier` labels subset of `haiku, sonnet, opus, fable`, `effort` subset of `low, medium, high, xhigh`, **both in ascending order** (the `score` expectation uses label index as the ordinal level).
  `plan_first` / `delegate_explore` are exactly `["no","yes"]`.
- `max_len`: int in [8, 8192], counted in tokens **including** special tokens.
- `temperatures`: optional, `{head: T > 0}`, default 1.0 per head. Unknown head names rejected.
- `thresholds.abstain`: optional `{head: min_confidence in [0,1]}`; `/v1/route` sets `abstain: true` when the `tier` **or** `effort` confidence (calibrated max-probability) is below its value. Default 0.
- `thresholds.yes`: optional `{binary head: cutoff}`; boolean answers are `P(yes) > cutoff`. Default 0.5.
- `input_template`: must contain `{text}`. Other placeholders are header fields (below).
- `head_frac`: optional, share of `max_len` kept from the **head** when truncating (default 0.75).

## meta.json

`{"run_id": "<non-empty string>", "metrics": {...}}` — `run_id` is required (returned as `model_run_id`); `metrics` is an optional free-form summary object
(agreement vs teacher, ECE, under-routing rate, ...). Optional `"model_sha256"`: if present it is verified against `model.onnx`.
Other keys are kept and ignored.

## Input text (must match training exactly)

`text = render(input_template, prompt, context)`, then `tokenizer.encode(text)` (post-processor adds special tokens), then **head/tail truncation at the token level**:
if `len(ids) > max_len`, keep the first `ceil(head_frac*max_len)` ids and the last `max_len - that` ids (so the leading `[CLS]`-like and trailing `[SEP]`-like tokens survive).

Header fields available to the template (all come from the request `context`; the daemon never errors on a missing one):

| placeholder | source key(s) in `context` | default |
|---|---|---|
| `lang` | `lang` | derived from the prompt (`ru`/`en`/`other`, same as `plugin/core/task.ts`) |
| `repo` | `repo` (list or string; also `languages`) | `unknown`; lists joined with `,` |
| `ctx` | `ctx`, `context_tokens`, `contextTokens` | `unknown`; numbers rendered compactly (`950`, `1.2k`, `82k`) |
| `files_in_repo` | `files_in_repo` | `unknown`; compact like `ctx` |
| `start` | `start`, `start_kind`; else `is_session_start` -> `session`/`mid` | `unknown` |
| `prev_task` | `prev_task`; else `prev_task_was_heavy` -> `heavy`/`light` | `none` |
| `git_dirty` | `git_dirty` | `0` |
| `mentions` | `mentions` | derived: number of distinct file paths in the prompt |
| `text` | the prompt; a list of prompts is joined with a blank line | required |
| anything else | same-named scalar in `context` | `unknown` |

Placeholders are expanded in one pass; `{...}` inside the prompt is never re-expanded.

## Open points to reconcile with `training/`

1. Does the exporter emit `logits_<head>` output names and 2-logit binary heads? (If it emits a single concatenated logits tensor, either re-export or change `OUTPUT_PREFIX` handling in `contract.py` / `backends.py`.)
2. Exact `input_template` placeholder set and number formatting (`ctx=82k`) vs. what the dataset builder renders; the spec shows `[mentions=2 files]`, here the template would simply read `[mentions={mentions} files]`.
3. Multi-prompt tasks (`tasks.jsonl` `text` is a list): the daemon joins with a blank line; training must do the same (or send only the first prompt).
4. `new_task` head (spec §4) is optional here; add it to `heads` and it is served automatically as a `noul`/`choice` question.
