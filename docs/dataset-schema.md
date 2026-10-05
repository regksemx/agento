# agento dataset: `tasks.jsonl` schema (v1)

Produced by `agento dataset build` (task T30, `docs/spec-phase-2-training.md`). One JSON object per line, one line per task.
Code: `cli/src/dataset/`. The file contains **scrubbed** prompt text and derived numbers only; it is still private data of
the owner and must never leave the machine unscrubbed or be published.

```
agento dataset build [--dir <projects>] [--since all|30d|2w|YYYY-MM-DD] [--project <text>] [--out <file>] [--lang ru|en] [--no-color]
```

| Item | Default |
|---|---|
| `--since` | `all` (the audit defaults to `30d`; a training set wants everything) |
| `--out` | `$AGENTO_HOME/dataset/tasks.jsonl`, `AGENTO_HOME` defaults to `~/.agento` |
| summary | `<dir>/summary.json` next to the default file; `<name>.summary.json` for a custom `--out` |

Both files are written to a temp file in the same directory and renamed over the target (mode `0600`).
Tasks are the audit's tasks (`segmentSession`: first prompt, after `/clear` or compaction, after more than 30 min of idle main line).
Records are sorted by `startTs`.

## Record

```jsonc
{
  "v": 1,
  "taskId": "9f2c0a41b7d3e856",       // first 16 hex of sha256("agento:" + sessionId + ":" + startTs); not reversible
  "project": "~/Projects/agento",      // session cwd with the home directory replaced by "~"
  "startTs": 1790000000000,            // epoch ms of the first human prompt
  "text": ["first prompt", "follow-up 1", "follow-up 2", "follow-up 3"],
  "context": { ... },
  "observed": { ... },
  "difficulty": 0.42,                  // L0, 0..1
  "l0Tier": "sonnet",                  // L0, "haiku" | "sonnet" | "opus"
  "l0Effort": "medium",                // L0, "low" | "medium" | "high"
  "rulesVerdict": { "tier": "sonnet", "effort": "high", "confidence": 0.4, "reasons": ["no strong signal"] },
  "labelSource": "L0"
}
```

`l1` and `l2` are **absent** until `dataset judge` (L1) and `dataset replay` (L2) add them.

### `text`
The first human prompt of the task plus up to 3 later human prompts inside the task window (slash commands are not prompts).
Order of operations: **scrub the whole prompt, then cut to 1500 chars**, so a cut can never keep half of a secret.

### `context`
| Field | Meaning |
|---|---|
| `contextTokensAtStart` | prefix (input + cache read + cache write) of the first main call of the task |
| `startKind` | `first-prompt`, `compact`, `clear` or `idle`, decided by `isTaskStart` (spec §4.4) with a 30 min idle limit |
| `languages` | up to 3 languages by number of distinct files touched by Read/Edit/Write/MultiEdit/NotebookEdit/Grep, from extensions; markup and config files (md, json, yaml, ...) are ignored |
| `hasGitBranch` | the transcript recorded a git branch |
| `prevTaskWasHeavy` | the previous task of the same session got `l0Tier: "opus"` (false for the first task) |

### `observed`: what happened, NOT the label
It describes the choice the human made and the trajectory it produced. Training on it as a target would teach "always Opus".

| Field | Meaning |
|---|---|
| `model`, `modelTier` | dominant main-line model (by output tokens) and its tier (`haiku/sonnet/opus/fable/unknown`) |
| `effort` | dominant effort of main calls, when recorded |
| `mainCalls`, `subagentCalls` | API requests in the task window on the main line / in subagents |
| `subagentTypes` | sorted distinct agent types of the subagents (`unknown` when the meta file is missing) |
| `filesEdited` | distinct files in Edit/Write/MultiEdit/NotebookEdit |
| `linesChanged` | Edit/MultiEdit: lines of `old_string` + lines of `new_string`; Write: lines of `content`. The transcript parser stores tool-input strings cut at 1000 chars, so very large edits are undercounted |
| `toolErrors` | tool results with `is_error` in the window (all lines) |
| `testRuns`, `testFailures` | Bash commands matching a test runner (vitest, jest, pytest, mocha, npm/pnpm/yarn/bun test, cargo/go/dotnet/deno/swift test, gradle/mvn test, phpunit, rspec, ...) and those whose result is an error |
| `sameEditRepeats` | edits that redo work: same file and same `old_string` as an earlier edit, or an `old_string` (>= 8 chars) found inside text the task wrote earlier to that file, or a second Write of a file |
| `userCorrections` | follow-up prompts (all of them, not only the 3 stored) matching `нет`, `не так`, `не то`, `неправильн*`, `откат*`, `верни*`, `revert*`, `wrong`, `stop`, `that's not`, `[Request interrupted` (whole words, case-insensitive) |
| `userInterrupts` | tool results saying the user rejected or interrupted a tool call ("doesn't want to proceed", "[Request interrupted"). The transcript parser drops interrupt rows from prompts, so this is where they show up |
| `planMode` | `ExitPlanMode` used on the main line |
| `durationMs` | first prompt to last main call |
| `outputTokens` | output tokens of all lines in the window |
| `cost` | USD, API-equivalent, all lines |

## Weak labels (L0)

> L0 labels are **weak**. They measure how hard the task turned out to be, not that a cheaper model would have been enough
> (spec §2). The thresholds below are placeholders, to be calibrated against L2 replays. `labelSource: "L0"` marks them.

All numbers live in one exported object, `L0_THRESHOLDS` in `cli/src/dataset/l0.ts`; change them there only.

**Tier**, first matching rule wins:

1. **opus**, if any of: `mainCalls >= 40`, `filesEdited >= 8`, `userCorrections >= 2`, `planMode`, `testFailures >= 3`.
2. **haiku**, if all of: first prompt is a question or lookup (short, up to 600 chars, and contains `?` or starts with a ru/en question or lookup word such as `что/как/где/почему/покажи/найди/объясни`, `what/how/where/why/show/find/explain`), `mainCalls <= 3`, `filesEdited = 0`, `linesChanged = 0`, `toolErrors = 0`.
3. **sonnet**, otherwise.

**Effort**: opus tier is `high`, haiku tier is `low`. For sonnet tier:

- `low`: `mainCalls <= 8`, `filesEdited <= 2`, `toolErrors = 0`, `userCorrections = 0`;
- `high`: `mainCalls >= 20`, or `filesEdited >= 4`, or `toolErrors >= 5`, or `userCorrections >= 1`;
- `medium`: otherwise.

**Difficulty** (0..1) is the sum of `weight * min(1, value / saturation)`:

| Signal | Weight | Saturates at |
|---|---|---|
| `mainCalls` | 0.30 | 40 |
| `filesEdited` | 0.20 | 8 |
| `linesChanged` | 0.10 | 500 |
| `userCorrections` | 0.15 | 2 |
| `toolErrors + testFailures` | 0.10 | 6 |
| `planMode` | 0.10 | (flag) |
| `subagentCalls` | 0.05 | 10 |

**`rulesVerdict`** is `classifyRules(extractFeatures(firstPrompt, ...))` from `plugin/core/task.ts` (rules v1), kept for comparison with L0 and later with the learned model. It contains only a tier, an effort, a confidence and short reasons.

Known limits, to fix by calibration: a long agentic task (>= 40 calls) is "opus" even when every step was easy; the question detector is lexical; nothing here sees whether the result was good.

## Scrubbing (`cli/src/dataset/scrub.ts`)

Principle: never leak, prefer over-scrubbing. Applied to every prompt before it is stored (and to the project label). Rules, in order:

| Kind | What | Replacement |
|---|---|---|
| `private-key` | `-----BEGIN ... PRIVATE KEY-----` blocks; an unterminated block is cut to the end of the text | `[SECRET]` |
| `url-credentials` | `scheme://user:password@host` | `scheme://[SECRET]@host` |
| `jwt` | `eyJ....xxx.yyy` | `[SECRET]` |
| `api-key` | `sk-ant-*`, `sk-*`, `ghp_/gho_/ghu_/ghs_/ghr_*`, `github_pat_*`, `AKIA/ASIA*`, `xox[abposr]-*`, `AIza*`, Stripe `sk_/rk_/pk_ live/test`, `npm_*`, `hf_*`, `glpat-*` | `[SECRET]` |
| `bearer` | `Bearer <token>` | `Bearer [SECRET]` |
| `assignment` | value of `password`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `api_key`, `apikey`, `access_key`, `private_key`, `credential(s)`, `authorization` (also inside longer names such as `DB_PASSWORD`) after `=`, `:`, `:=`, `=>`, in JSON, and after `--flag ` | key kept, value `[SECRET]`; type names, `null`, `$VAR`, `${VAR}`, `<placeholder>`, `process.env.*`, `os.environ*` and `max_tokens: 4096` are kept |
| `email` | `name@domain.tld` | `[EMAIL]` |
| `home-path` | `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` | `~` |
| `high-entropy` | runs of >= 32 chars of `A-Za-z0-9+/_-` with a digit and Shannon entropy >= 4.0 bits/char (pure hex: >= 3.2; lowercase slugs and paths with `-_/`: >= 4.3). UUIDs, 40-char git SHAs, and strings without digits are exempt | `[SECRET]` |

`summary.json` and the terminal summary report hit counts per kind (never the matched text).

## `summary.json`

`version`, `generatedAt`, `out`, `tasks`, `sessions`, `projects`, `filters {since, project?}`, `l0Tier`, `l0Effort`, `observedTier`,
`confusion[observedTier][l0Tier]`, `overSpec {count, share, cost}` (Opus or Fable in history while L0 says sonnet or haiku),
`withCorrections {count, share}`, `rulesAgreement` (share of tasks where rules v1 and L0 pick the same tier), `totalCost`,
`scrub {hits, total}`, `durationMs`. No prompt text.

## What comes next

- `dataset judge` (T31): L1, Opus reads the finished task and says whether Sonnet or Haiku would have done it; adds `l1`.
- `dataset replay` (T32): L2, re-runs the task on a cheaper configuration in a git worktree; adds `l2` and calibrates the L0 thresholds.
