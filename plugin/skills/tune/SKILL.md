---
name: tune
description: Audit this Claude Code setup for token waste and propose concrete fixes — trim and restructure CLAUDE.md, move rarely needed instructions into skills, and suggest settings (model, effort, cache TTL, subagent models). Use when the user asks to optimize, slim down or "tune" their CLAUDE.md or Claude Code setup, or after `agento audit` flags an expensive CLAUDE.md.
---

# agento: tune the setup

Goal: the same quality of work for fewer tokens. Every byte of CLAUDE.md is sent with every request of every session,
so a 200 KB CLAUDE.md costs ~55k tokens per request. Only propose changes; apply nothing without the user's explicit OK.

## 1. Gather facts (cheaply)

1. Run `npx -y agento-cc audit --json --since 30d` (or `node <repo>/cli/dist/agento.mjs audit --json` when working inside the agento repo) and read `setup.claudeMd`, `actions`, `tasks`, `subagents`, `ttl`.
2. Find the CLAUDE.md files in play for this project: `./CLAUDE.md`, `./.claude/CLAUDE.md`, `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), plus files they `@import`. Report the size of each in KB and approximate tokens (bytes ÷ 3.6).
3. If a CLAUDE.md is larger than ~20 KB, delegate the reading to the `agento-scout` agent: ask it to classify every section as one of
   - **always-needed facts** (build/test commands, repo layout, hard rules, conventions the model breaks without them),
   - **procedures** (step-by-step how-tos used only for specific tasks),
   - **reference** (long lists, API docs, examples, history, changelogs),
   - **stale or duplicated** (contradictions, things the code or git history already says, repeated rules),
   with byte counts per section.

## 2. Propose

Write the proposal in the user's language as:

1. **Slim CLAUDE.md** — keep only always-needed facts; target ≤ 200 lines and ≤ 20 KB. Show it in full.
2. **New skills** — each procedure becomes `.claude/skills/<name>/SKILL.md` with a precise `description` (that is what makes it load only when relevant). List them with one-line descriptions.
3. **Moved reference** — long reference material goes to `docs/…` and CLAUDE.md links to it with one line ("for X see docs/x.md").
4. **Dropped** — stale/duplicated content, with one reason each.
5. **Settings** — only those the audit supports with numbers, e.g.:
   - default model / effort for routine work (`/model sonnet`, `/effort medium`) when light tasks on Opus are frequent;
   - `CLAUDE_CODE_SUBAGENT_MODEL` or per-agent `model:` when Explore/general-purpose subagents run on Opus;
   - `promptCacheTtl` when `ttl.recommendation` says so;
   - `/clear` habits when dead-context cost is high.
6. **Expected effect** — tokens per request before → after, and the monthly estimate from the audit, labeled as an estimate.

## 3. Apply only on approval

Ask which parts to apply. Then make the edits, keeping the old CLAUDE.md as `CLAUDE.md.bak` (or rely on git if the file is tracked and the tree is clean — say which). Never delete instructions the user did not approve dropping.
