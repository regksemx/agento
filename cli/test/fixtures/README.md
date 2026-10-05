# Transcript fixtures

## Transcript format notes

Observed on a real Claude Code `projects` dir (~950 files, 460k lines, Claude Code 2026-09/10 builds). All fixtures are synthetic.

**Layout**
- Main: `<project>/<sessionId>.jsonl`; one `sessionId` per file, equal to the file name. `<project>` is the cwd with `/` replaced by `-`.
- Subagents: `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, also nested: `subagents/workflows/<wf>/agent-<agentId>.jsonl`. `journal.jsonl` next to them is not a transcript. Each `agent-<id>.jsonl` may have `agent-<id>.meta.json` beside it: `{"agentType":"general-purpose|Explore|fork|workflow-subagent|...","description":"...","toolUseId":"...","spawnDepth":1}` (older builds have none: the type is then unknown). Rows carry `agentId` (= file name) and `isSidechain: true`; their `sessionId` usually equals the parent, but a few forked agents carry another id, so the parent is taken from the directory. The first user row of a subagent is the task text from the parent, not a human prompt. Main files never contain sidechain rows. `tool-results/` dirs hold other files (md, txt, json), ignored.
- Lines can be huge (1 MB+) and the odd one is truncated (bad JSON): skip and count.

**Row types** (top-level `type`): `assistant`, `user`, `attachment`, `system`, plus bookkeeping rows that are ignored (`last-prompt`, `mode`, `permission-mode`, `ai-title`, `queue-operation`, `file-history-*`, `bridge-session`, `frame-link`, `pr-link`, ...). Key order is not stable (assistant rows put `message` before `type`), so never sniff `"type"` in the raw line.

**assistant rows = API requests**
- `message.{id,model,content[],stop_reason,usage}`, `requestId`, `timestamp` (ISO), `effort`, `perTurnEffort`.
- One request is written as several rows, one per content block, same `(message.id, requestId)`, same usage except `output_tokens`: the LAST row has the final `output_tokens` (always the max) and its own `stop_reason`; each row holds only its own content block, so `tool_use` blocks must be merged across the group. About half of all rows are such repeats.
- Resumed/forked sessions copy earlier requests into a new file (and subagent files) with identical ids: ~1000 keys appear in 2+ files. Dedupe must be corpus-wide, otherwise spend is double counted.
- `model: "<synthetic>"` = client-generated error/notice row with zero usage; not an API call.
- `usage`: `input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `service_tier`, `speed` (`"standard"`; `"fast"` expected for fast mode, absent on older builds), plus noise (`iterations`, `inference_geo`, `server_tool_use`, ...).
- `effort` is the effort of the turn (`low|medium|high|xhigh|max`); `perTurnEffort` is a duplicate that is sometimes absent. 94 rows of 38k have neither.
- 56 rows have no `requestId` (still deduplicated by message id).

**user rows**
- Tool result carriers: `message.content` is a list with `tool_result` blocks (`tool_use_id`, `is_error`, `content` string or text blocks); row also has `toolUseResult`. ~90% of user rows.
- Human prompts: `message.content` is a string (or list of `text`/`image` blocks), `origin: {kind:"human"}`, `promptSource: "typed"` (or `"queued"`). Older builds have neither field (plain string, no `isMeta`).
- Not human: `isMeta: true` (system reminders, caveats), `isCompactSummary` (+ `isVisibleInTranscriptOnly`), `origin.kind` of `task-notification | coordinator | peer | unclassified | auto-continuation`, `promptSource: "system"`, text starting with `<task-notification`, `<system-reminder`, `<local-command-caveat`, `<local-command-stdout`, `<bash-input|stdout`, and `[Request interrupted by user`.
- Slash commands are user rows whose text is `<command-name>/model</command-name><command-message>model</command-message><command-args>...</command-args>`, followed by a user row `<local-command-stdout>...</local-command-stdout>`. Seen: `/model` (stdout `Set model to \`Opus 5.5 (1M context)\` and saved ...`), `/effort` (`Set effort level to high (saved ...)`), `/clear`, `/compact` (stdout `Compacted (ctrl+o ...)`), `/permissions`, `/exit`, `/goal`, ... Skill-style commands typed by the human appear as plain text starting with `/`. The `/model`/`/effort` args are empty when picked from a menu: the result names the choice. A few `/model`, `/context`, `/usage` runs appear as `system` rows with `subtype: "local_command"` instead (same `<command-name>` / `<local-command-stdout>` content).
- `/clear` does NOT start a new file or session id: it is a `/clear` command row inside the same file (then a `local_command` system row).

**system rows** (`subtype`)
- `compact_boundary`: `compactMetadata.{trigger: "manual"|"auto", preTokens, postTokens, ...}`; followed by a user row with `isCompactSummary: true`. A manual `/compact` produces both the command row and the boundary.
- `away_summary`: "while you were away" recap (`content`), emitted after an idle return; a useful idle marker.
- `turn_duration`, `stop_hook_summary`, `informational`, `scheduled_task_fire`: ignored. `model_refusal_fallback` (`originalModel`, `fallbackModel`) is kept as marker `other`.

**cost-state rows** (no `timestamp`): `totalCostUSD` (cumulative, monotonic within a file), `modelUsage{model: {costUSD, ...}}`; 1-5 per file; the last one is the session's reported cost. Against list-price recomputation (cache TTL split, dedupe) the median deviation is about -2% and ~92% of sessions are within +-10%. Sessions whose requests all sit in another file (resumed copies) are not comparable.

**Parser decisions**: the call timestamp is the LAST row's; `<synthetic>` rows are dropped and counted in `unknownModelCalls` (unknown model ids stay in `calls`, priced as null); tool inputs are kept but long strings cut to 1000 chars; with `since`, `reportedCostUSD` is cleared for sessions that lost calls to the filter.

## Fixture projects (`projects/`)

A fake projects dir. Timestamps are 2026-06..09, no real content. Tests copy it to a temp dir and set mtimes.

| File | Covers |
|---|---|
| `-tmp-demo-app/sess-main.jsonl` | Main thread: 3 rows for one request (text + Read + Grep) -> dedupe keeps 1 call with output 150 and 2 tool uses; fast-speed row; 1h cache write; `<synthetic>` row; one truncated JSON line; meta and task-notification user rows (not prompts); an error tool_result (3000 chars -> 2000); a 1500-char tool input; `cost-state` x2 (last = computed total x 1.04). |
| `-tmp-demo-app/sess-main/subagents/agent-a1b2.jsonl` (+ `.meta.json`: Explore) | Sonnet subagent, Read + `ls` + Grep: haiku candidate. |
| `.../agent-c3d4.jsonl` (+ meta: general-purpose) | Opus subagent that edits: not a haiku candidate, a sonnet candidate. |
| `.../agent-e5f6.jsonl` (no meta file) | Haiku subagent (already cheap); type unknown. |
| `.../workflows/wf_fixture1/agent-g7h8.jsonl` (+ meta: workflow-subagent) + `journal.jsonl` | Nested workflow agent (opus, `rm -rf` in Bash: not read-only); journal must be ignored. |
| `-tmp-demo-app/sess-idle.jsonl` | Idle gaps (+2 min, +20 min, +90 min), 1h cache write, `away_summary`, auto `compact_boundary` + compact summary row, manual `/compact` + boundary, `cost-state` at 0.97x. |
| `-tmp-demo-lib/sess-cmds.jsonl` | `/model` (+stdout, +system variant), `/effort`, `/clear`, a `/review x` prompt, `<pasted_content>` prompt, coordinator/interrupt rows, effort change, Sonnet calls, `cost-state` at 1.5x (outside tolerance). |
| `-tmp-demo-lib/sess-resumed.jsonl` | A resumed session containing a copy of one request of `sess-cmds` (cross-file dedupe) plus a new one. |
| `-tmp-old/sess-old.jsonl` | Old data (2026-06); test sets an old mtime to check the `since` pre-filter. |
