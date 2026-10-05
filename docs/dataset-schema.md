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

`l1` and `l2` are **absent** from `tasks.jsonl`: L1 verdicts live in `judge/<backend>-<model>.jsonl` (see below), L2 will add its own file.

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

## L1: `agento dataset judge`

Task T31, spec §2 L1. A judge model reads each **finished** task (scrubbed prompts, context header, the observed trajectory of the
strong-model run) and says, for every configuration of the ladder, how likely it would have done the task at the same quality on the
first try. Code: `cli/src/dataset/judge/`. The L1 label is **unvalidated** until L2 replays confirm it; the terminal summary says so.

```
agento dataset judge --backend openai --base-url <url> --model <name> [--api-key-env VAR] [--structured] [--concurrency N]
agento dataset judge --backend claude --model <haiku|sonnet|opus> --max-tasks N [--yes]
  common: [--threshold 0.7] [--max-tasks N] [--force] [--dry-run] [--timeout sec] [--retries N] [--tasks <file>] [--out <file>] [--lang ru|en] [--no-color]
```

| Item | Behaviour |
|---|---|
| input | `$AGENTO_HOME/dataset/tasks.jsonl` (`--tasks` overrides) |
| output | `$AGENTO_HOME/dataset/judge/<backend>-<model>.jsonl`, model name sanitized to `[A-Za-z0-9._-]` (`/` becomes `_`); `--out` overrides. `tasks.jsonl` is never modified |
| resume | one line per verdict, appended as soon as it exists (a single write per line, mode `0600`). A run skips every `taskId` that already has an `ok` verdict; `--force` judges them again (the last `ok` record per `taskId` wins). A torn last line from a crash is closed and ignored. Verdicts made with another `promptVersion` are kept and reported (use `--force` to redo them) |
| `--max-tasks N` | at most N pending tasks per run; the sample is ordered by `taskId` (a hash), so it is stable and not biased to early history. **Required** for `--backend claude` (except with `--dry-run`) |
| `--dry-run` | counts, input tokens (chars / 3.6, system prompt included per call), output tokens (about 220 per task); for `claude` an API-equivalent cost (upper bound, no caching, +1.5k tokens overhead per call). Calls nothing |

**`openai` backend.** Any OpenAI-compatible `POST <base-url>/chat/completions` (vLLM, llama.cpp server, ...), global `fetch`, `temperature: 0`.
`--structured` adds `response_format: {type: "json_schema", json_schema: {name: "agento_judge", strict: true, schema}}` (vLLM guided JSON);
without it the prompt asks for JSON and the answer is parsed robustly. `--api-key-env VAR` names the environment variable with the key
(sent as `Authorization: Bearer`). `--concurrency` defaults to 8, `--timeout` to 120 s, `--retries` to 3 (exponential backoff with jitter on network errors, timeouts, 408/425/429 and 5xx; other 4xx are not retried).
After 5 consecutive transport failures the run stops (the backend is considered down). The prompt is sent to whatever endpoint you give: use only a server you control, even though the text is scrubbed again before sending.

**`claude` backend.** `claude -p --model <m> --output-format json --no-session-persistence --disable-slash-commands --tools "" --system-prompt <system>`, the task on stdin, cwd in the temp dir.
It spends the subscription limit (or API credit), so it prints the estimate and asks for confirmation unless `--yes` (without a terminal and without `--yes` it refuses). Default `--concurrency` is 2.

**Prompt** (`prompt.ts`): English, version-hashed (`promptVersion` = first 12 hex of sha256 over system prompt, schema and examples). The judge is told that the expensive
model was chosen by habit, that trajectory length is a weak signal (exploration, breadth, user back-and-forth), that corrections can mean a changed mind rather than difficulty, and to be calibrated and keep p non-decreasing along the ladder.
It sees only scrubbed text (scrubbed again at build time of the prompt; prompts are fenced in `<prompt>` tags and treated as data), never the `taskId`. Four synthetic few-shot examples: lookup, mechanical rename, debugging, architecture.
The answer is one JSON object, `rationale` first so the judge reasons before it commits to numbers.

## Record (`judge/<backend>-<model>.jsonl`)

```jsonc
// success
{
  "v": 1,
  "taskId": "9f2c0a41b7d3e856",
  "ts": 1790000000000,                // when the verdict was written
  "judgeBackend": "openai",           // "openai" | "claude"
  "judgeModel": "Qwen/Qwen3-32B",     // as given on the command line
  "judgeModelResolved": "Qwen/Qwen3-32B", // what the backend reports, when it does
  "promptVersion": "5d4f531479c8",
  "ok": true,
  "threshold": 0.7,
  "l1Tier": "sonnet",                 // derived label, see below
  "l1Effort": "medium",
  "l1Probs": { "haiku-low": 0.2, "sonnet-medium": 0.8, "sonnet-high": 0.9, "opus-medium": 0.95 },
  "l1Difficulty": 3,                  // 1..5
  "needsPlanFirst": false,
  "delegateExplore": true,
  "rationale": "<= 2 sentences",
  "usage": { "inputTokens": 3000, "outputTokens": 100, "costUsd": 0.012 }   // as reported; costUsd only for claude
}
// failure: the model answered but the answer is not valid (retried by the next run, never counts as judged)
{ "v": 1, "taskId": "...", "ts": 1790000000000, "judgeBackend": "openai", "judgeModel": "...", "promptVersion": "...",
  "ok": false, "error": "probs.sonnet-high: expected a number", "raw": "<first 300 chars of the answer>" }
```

Transport failures (connection refused, timeout, HTTP error after retries, non-zero exit of `claude`) are counted in the run summary but not written.

**Derived label**: the cheapest configuration of `haiku·low < sonnet·medium < sonnet·high < opus·medium` with `p >= --threshold` (default 0.7), otherwise `opus·medium`.
A cheaper configuration with p above the threshold wins even if a dearer one is (inconsistently) lower. The stored `l1Tier`/`l1Effort` use the threshold of the run that wrote them;
the terminal summary re-derives labels from `l1Probs` with the current `--threshold`, so thresholds can be explored without re-judging.

**Parsing**: `<think>` blocks and code fences are stripped, then every balanced `{...}` (string-aware) is tried in order and the first one that validates is used.
Config keys may be written `haiku-low`, `haiku·low`, `Haiku Low`, `haiku_low`. Probabilities must be numbers in 0..1 (no percent strings), `difficulty` is rounded, the rationale is cut at 400 chars.

**Terminal summary** (audit visual language): judged / skipped / failed, token usage and cost, distribution over the four configurations, plan-first and delegate-explore shares,
agreement matrix L0 x L1, observed model x L1 with the line "ran on Opus/Fable, judge says sonnet or haiku suffices: N tasks, $X (saving ≈ $Y at the judged tier's list price)", and a dim note that L1 is unvalidated.

## L2: `agento dataset replay`

Task T32, spec §2.1. Re-runs a past task on cheaper configurations in a throw-away git worktree and checks the result. The cheapest
configuration that passes is the **gold** (L2) label, and the main output is the validation of the L1 judge (L1 vs L2). Code:
`cli/src/dataset/replay/`. **It spends the Claude limit** (subscription) or money (`ANTHROPIC_API_KEY`), so everything is guarded.

```
agento dataset replay --max-tasks N --budget-usd X [--yes] [--dry-run | --select]
  [--ladder haiku-low,sonnet-medium,sonnet-high,opus-medium] [--samples 2] [--install] [--prefer-l1-disagreement] [--include-dirty]
  [--judge-diff --judge-backend <openai|claude> --judge-model <m> [--judge-base-url <url>] [--judge-api-key-env VAR] [--structured]]
  [--judge-file <file>] [--threshold 0.7] [--bash safe|all|none] [--run-timeout sec] [--test-timeout sec] [--max-turns N]
  [--max-commit-age-days 14] [--max-runs-per-day N] [--tasks <file>] [--dir <projects>] [--project <text>] [--out-dir <dir>] [--force] [--lang ru|en] [--no-color]
```

### Safety guards

| Guard | Behaviour |
|---|---|
| required flags | `--max-tasks` and `--budget-usd` (except `--select`, which only lists the selection) |
| plan + confirmation | prints tasks x ladder x samples, an estimated cost range, the account (`ANTHROPIC_API_KEY` present = API key, real money; Bedrock/Vertex/Foundry = cloud; otherwise subscription = weekly limit) and asks `[y/N]`. Without `--yes` and without a terminal it refuses (exit 1) |
| `--dry-run` | selection + plan, runs nothing, creates no worktree, spawns no `claude` |
| budget | per run the estimate is the task's own tokens (all lineages) repriced as the configuration's tier, times 1.5. A run whose estimate exceeds the remaining budget never starts; the whole replay stops (no label for a half-finished ladder). `claude` also gets `--max-budget-usd` = min(remaining, max(2 x estimate, $0.5)) |
| daily cap | without an API key at most 40 runs per local day (`--max-runs-per-day`), counted from `runs.jsonl` |
| infrastructure errors | a run that yields no usable result (spawn failure, no JSON, an error before any turn: auth/credit) is `status: "error"`, gives the task **no label** (never a fake `opus·medium`), is retried by the next invocation, and 3 in a row stop the replay (exit 1) |
| user's tree | never written to. `git worktree add --detach <tmp>/<taskId> <commit>`; removed with `git worktree remove --force` + `prune` after each task, and by cleanup handlers on exit, SIGINT/SIGTERM/SIGHUP and uncaught errors; child processes are killed as a process group |
| prompts | read from the transcripts in memory (a prompt cut by the parser at 4000 chars is re-read raw) and passed to `claude` on **stdin**; never written to disk by agento and never stored in `runs.jsonl`/`labels.jsonl` |
| Bash for the agent | `--bash safe` (default): the recorded test command plus read-only commands (`git status/diff/log/show`, `ls`, `cat`, `head`, `tail`, `grep`, `find`, `wc`, `pwd`); `all`: any command **unsandboxed, as you** (cwd is the worktree, nothing stops it leaving it); `none` |

### Selection (`--select`)

A task is replayable when all hold (reason when it is not, counted in the summary):

| Reason | Rule |
|---|---|
| `already-labeled` | has a label in `labels.jsonl` (`--force` ignores) |
| `no-source` | the task is not in the local transcripts any more (taskIds are rebuilt from them) |
| `multi-prompt` | the task window has one human prompt, or only bare confirmations after it (`да`, `ок`, `продолжай`, `yes`, `go on`, ... up to 4 words from a fixed list) |
| `no-cwd`, `cwd-missing`, `not-a-repo` | the session cwd is recorded, exists and is inside a git repository |
| `no-branch`, `branch-missing` | `gitBranch` is recorded (not `HEAD`) and still exists locally (or as `origin/<branch>`) |
| `no-commit`, `stale-commit` | starting commit = latest commit on that branch with commit time <= task `startTs` (`git log --before`); older than 14 days (`--max-commit-age-days`) is skipped |
| `dirty-start` | see below; skipped unless `--include-dirty` (those candidates carry `dirtyStart: true`) |
| `no-verification` | the original task edited no files: a replay that changes nothing passes any test command and any diff check, so it would prove nothing (read-only tasks are not replayed) |

**Dirty start** = either signal: (1) a file the session had already modified before the task (`Edit`/`Write` calls, `file-history-snapshot`
rows with `trackedFileBackups[*].backupTime`, `file-history-delta` rows) has no commit on the branch on or after that modification time
(gitignored files are ignored); (2) the task's first `Edit` of a file has an `old_string` that is not in that file at the commit (or the file is absent).
Hand edits made outside any Claude session cannot be seen, except through signal 2.

**Verification command** (repository root at the commit, nested projects are not looked up): `package.json` `scripts.test` (not the npm placeholder; `pnpm`/`yarn`/`bun`/`npm` by lockfile), `go.mod` -> `go test ./...`, `Cargo.toml` -> `cargo test`,
pytest (`pytest.ini`, `conftest.py`, or `pytest` in `pyproject.toml`/`setup.cfg`/`tox.ini`) -> `python3 -m pytest -x -q`, `gradlew` -> `./gradlew test`, `build.gradle(.kts)` -> `gradle test`, `pom.xml` -> `mvn -q test`.
Tasks with a test command are preferred (the test check is strong; the diff check alone is weak). Order: tasks with a test command first, then (`--prefer-l1-disagreement`) tasks where the judge file says cheaper than what ran, then by `taskId`.

### Run and ladder

`claude -p --model <haiku|sonnet|opus> --effort <low|medium|high> --permission-mode acceptEdits --output-format json --no-session-persistence --max-budget-usd <cap> --allowed-tools <list>`, prompt on stdin, cwd = the worktree (plus the session's sub-directory).
Flags were checked against `claude --help` (2.1.x). **`--max-turns` is not listed by that help**, so it is passed only with an explicit `--max-turns N`; the run is otherwise bounded by `--max-budget-usd` and `--run-timeout` (default 1200 s).
Neutral follow-ups are appended to the prompt once (`-p` has no second turn). `--install` (off by default) first runs the lockfile install in the worktree
(`npm ci`, `pnpm/yarn/bun install --frozen-lockfile`, `uv sync --frozen`, `poetry install`); go/cargo fetch on demand.

Per task: the test command is run **once on the starting commit** (baseline). If it is red there (typically: dependencies not installed), the test check is `unavailable` for that task, not a failure.
Ladder (default `haiku·low -> sonnet·medium -> sonnet·high -> opus·medium`, `--ladder`), `--samples` (default 2) runs per configuration, the worktree is reset to the commit between runs.
Checks per run, evaluated cheapest first:

| Check | Rule |
|---|---|
| `tests` | the recorded command exits 0 (only when the baseline was green) |
| `diff` | `git diff` against the commit is not empty, for tasks whose original edited files |
| `judge` | `--judge-diff`: a judge model (the `openai` or `claude` judge backend) answers whether the replay diff solves the same task as the original diff without regressions. The original diff is rebuilt from the transcript's Edit/Write/MultiEdit inputs, **re-read raw** (the parser cuts tool-input strings at 1000 chars); main line only, best effort. Both diffs and the task text are scrubbed before being sent. Runs only when the other checks passed |

A run passes only if every evaluated check passes (at least one must be evaluated) and `claude` did not report an error (turn/budget cap).
A configuration passes only if all samples pass (a failed first sample skips the rest). The ladder stops at the first passing configuration; label = that
configuration, or `opus·medium` if none passed (`passedConfig: null`). Resume: finished runs in `runs.jsonl` are reused, so an interrupted ladder continues without paying again.

A non-empty diff is a weak check (any edit passes): for tasks without tests prefer `--judge-diff`.

## Records (`$AGENTO_HOME/dataset/replay/`)

`runs.jsonl` (every run, appended as it finishes) and `labels.jsonl` (one per task, appended after its ladder; the last wins). Torn last lines are ignored.
**No prompt text is stored.**

```jsonc
// runs.jsonl
{
  "v": 1, "taskId": "9f2c0a41b7d3e856", "ts": 1790000000000,
  "config": "sonnet-medium", "tier": "sonnet", "effort": "medium", "sample": 1,
  "status": "ok",                      // "ok" | "timeout" (a failed sample) | "error" (infrastructure, no verdict)
  "agentError": "error_max_budget_usd",// only when claude reported is_error
  "checks": { "tests": "pass", "diff": "pass", "judge": "skipped" },   // pass | fail | skipped | unavailable | error
  "pass": true,
  "costUsd": 0.31, "judgeCostUsd": 0.02, "numTurns": 12, "durationMs": 84000,
  "diffFiles": 3, "diffLines": 42
}
// labels.jsonl
{
  "v": 1, "taskId": "9f2c0a41b7d3e856", "ts": 1790000000000,
  "l2Tier": "sonnet", "l2Effort": "medium",
  "l2Evidence": {
    "passedConfig": "sonnet-medium",   // null: nothing passed, the label is the opus·medium fallback
    "steps": [ { "config": "haiku-low", "samples": 1, "passed": 0, "pass": false }, { "config": "sonnet-medium", "samples": 2, "passed": 2, "pass": true } ],
    "testCommand": "npm test", "testBaseline": "pass",
    "checks": ["tests", "diff"],       // checks that applied to this task
    "commit": "<40 hex>", "samples": 2
  },
  "costUsd": 1.42                      // all runs of the task
}
```

`tasks.jsonl` is never modified. Joining is by `taskId`.

**Terminal summary**: selected / replayed / labeled / skipped with reasons, runs and money spent against the budget, L2 label distribution (and the opus·medium fallback share),
observed model x L2 (with "ran on Opus/Fable, L2 found sonnet or haiku enough"), and **L1 vs L2** from the newest file in `dataset/judge/` (`--judge-file` overrides): a tier matrix,
exact and same-tier agreement, "judge cheaper than what sufficed" (under-routing, the quality risk) and "judge dearer than needed" (missed saving). A dim note says L2 is calibration, not truth (2 samples, only detectable checks).

## Public data: `agento dataset import twinrouterbench`

Why and how the tiers map: `docs/public-data.md`. Code: `cli/src/dataset/public/`.

```
agento dataset import twinrouterbench [--source <path|git-url>] [--fetch] [--out <file>] [--lang ru|en] [--no-color]
```

| Item | Behaviour |
|---|---|
| `--source` | a TwinRouterBench checkout, its `data/static` directory or `question_bank.jsonl`; a git URL is cloned (depth 1) into `$AGENTO_HOME/cache/twinrouterbench` |
| `--fetch` | clone or update `https://github.com/CommonstackAI/TwinRouterBench` into that cache. Without `--source` and without `--fetch` the command refuses (nothing is downloaded implicitly) |
| output | `$AGENTO_HOME/dataset/public/twinrouterbench.jsonl` (mode `0600`) and `twinrouterbench.summary.json` next to it (`--out` overrides the first) |

```jsonc
{
  "v": 1,
  "taskId": "0bc5449b5116b766",          // first 16 hex of sha256("twinrouterbench:" + source id)
  "source": "twinrouterbench",
  "project": "twinrouterbench/swebench",
  "startTs": 0,
  "text": ["[system] ...\n\n[user] ...\n\n[assistant] ...\n→ bash({...})\n\n[tool] ..."],   // one element: the router-visible prefix, cut in the middle to ~6000 chars
  "context": { "contextTokensAtStart": 2278, "startKind": "agent-step", "languages": ["py"], "hasGitBranch": true, "prevTaskWasHeavy": false },
  "labelSource": "L2-public",
  "l2Tier": "opus",                        // mapped: low,mid -> haiku, mid_high -> sonnet, high -> opus
  "l2Evidence": { "publicTier": "high", "publicTierId": 3, "benchmark": "swebench", "scenario": "code_swe", "instanceId": "django__django-11163",
                  "stepIndex": 4, "totalSteps": 9, "benchmarkSubset": "verified_40", "pipelineStage": "degradation_search_done",
                  "sourceId": "swebench_django__django-11163_step_4", "prefixChars": 7294, "truncated": true, "messages": 8 }
}
```

`observed`, `difficulty`, `l0*` and `rulesVerdict` are absent (there is no Claude Code history behind a public step). `startKind` is `first-prompt` for step 1 and
`agent-step` after. `languages`/`hasGitBranch` are best effort (`py`/true for SWE-bench only). `summary.json` has the record and tier counts, per-workload
tier matrix, skipped rows by reason, prefix length statistics, the tier mapping and a `notice` with the Apache-2.0 attribution.

`agento dataset judge --tasks <public file>` judges these records too: the user prompt has a "Step of an agent run" section, the prefix in `<prefix>` tags and
the line "No trajectory available; judge from the prefix only." (own-history prompts are unchanged apart from the system prompt gaining a paragraph about
such records, so `promptVersion` changed). The judge summary then counts public records separately and skips the L0/history matrices for them.

## `agento dataset validate-judge`

```
agento dataset validate-judge --judge <judge.jsonl> [--labels <public.jsonl>] [--threshold 0.7] [--max-under 0.05] [--benchmark swebench,bfcl] [--out <json>] [--lang ru|en] [--no-color]
```

Joins judge verdicts and public labels by `taskId`; the L1 label is re-derived from the stored `l1Probs` with `--threshold` (default 0.7). Reports:

| Metric | Definition |
|---|---|
| accuracy | judge tier = verified tier |
| under-routing | judge cheaper than verified: the quality risk |
| over-routing | judge dearer than verified: a missed saving |
| confusion | verified x judge tier; by workload table |
| calibration | reliability table in 10 bins of p("sonnet suffices") = max(`sonnet-medium`, `sonnet-high`) against "verified tier is not opus"; ECE and Brier; ECE of "haiku suffices" |
| threshold sweep | thresholds 0.5, 0.6, 0.7, 0.8, 0.9: accuracy, under, over, saving = 1 - cost(routed) / cost(all opus) at blended list prices (equal weight per step); the no-loss ceiling (route exactly by verified tier) |
| recommendation | the threshold with the largest saving among those with under-routing <= `--max-under` (ties: the higher one); none if no threshold qualifies |

Exit code 1 when nothing could be compared. `--out` writes the same numbers as JSON (`ValidationSummary`).

## What comes next

- Calibrate the L1 threshold and the L0 thresholds against L2 (`labels.jsonl`); `agento train` takes L2 as gold.

## Human labels: `agento dataset label`

The owner labels a sample of their OWN past tasks in hindsight; this is the gold set for calibrating and evaluating the personal model and the L1 judge. Code: `cli/src/dataset/label/`.

```
agento dataset label [--n 50] [--strategy stratified|disagreement|random] [--seed N] [--judge <file>] [--lang ru|en]
agento dataset label --report            # distribution + agreement of L0 / rules / L1 / history with your labels
agento dataset label --export-csv [file] # labels with the guesses, no prompt text
```

Needs a terminal (raw-mode stdin). Each card shows the scrubbed first prompt and the observed trajectory; the L0, rules and L1 guesses are hidden until `g` (anti-anchoring). Questions: tier (1/2/3), effort (1/2/3), plan first (y/n), delegate exploration (y/n); `s` skip, `?` don't remember, `b` back, `q` or Ctrl+C stop. Every answer is appended at once.

Output: `$AGENTO_HOME/dataset/judge/human.jsonl`, one line per verdict, appended with a single write (mode `0600`); re-labeling appends again and the last line of a `taskId` wins.

| field | meaning |
|---|---|
| `taskId`, `ok: true`, `ts`, `v` | identity, like every judge line |
| `labelSource` | `"human"` |
| `labeledAt`, `labelerSeconds` | ISO time; seconds from showing the card to the last answer (capped at 3600) |
| `l2Tier`, `l2Effort` | the cheapest model and the effort that would have been enough on the first try |
| `l2PlanFirst`, `l2DelegateExplore` | booleans: a strong model should have planned first; exploration could go to a cheap subagent |
| `unsure` | `true` for "don't remember": all four `l2*` fields are `null`, which replaces an earlier verdict of the task |

`training/agento_train/export.py` merges `judge/*.jsonl` by `taskId` and reads the flat `l2*` fields as source **L2** (gold, weight 1.0) for all four heads. `human.jsonl` is merged last, so no other file overrides it. The replay's "newest judge file" lookup ignores `human.jsonl`.
