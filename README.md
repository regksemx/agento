<div align="center">

# ◆ agento

**Spend less of your Claude Code budget — without losing quality.**

A "System 1" for Claude Code: it right-sizes models at the start of a task, sends cheap work to cheap subagents,
hands architecture from Opus to Sonnet in a clean context, and stops agents that are going in circles.
Everything is measured in dollars (or % of your weekly limit), locally.

[Русская версия](README.ru.md) · [Research](docs/research.md) · [Spec](docs/spec-phase-0-1.md) · [Training plan](docs/spec-phase-2-training.md)

</div>

<p align="center"><img src="docs/assets/audit.svg" alt="agento audit" width="760"></p>
<p align="center"><img src="docs/assets/audit-actions.svg" alt="agento audit: top actions" width="760"></p>

> **Status: alpha.** `agento audit` and the plugin work today; the trained classifier is next.

## Quick start

See where your budget goes — reads your local Claude Code transcripts, sends nothing anywhere:

```sh
npx agento-cc audit            # last 30 days
npx agento-cc audit --since all --md report.md
```

Install the plugin (Claude Code ≥ 2.1.287):

```text
/plugin marketplace add <owner>/agento
/plugin install agento@agento
```

## What it does

| | Scenario | How it saves |
|---|---|---|
| 🎯 | **Right model for the task** — a light task on Opus/`max` effort gets a one-click "Sonnet · medium" suggestion when the task starts | Chosen before the cache warms up, so switching is free |
| 🏛 | **Architect → builder** — discuss architecture with Opus in plan mode, then code on Sonnet in a fresh context with only the plan | Sonnet starts with ~5–10k tokens instead of 100k+ of discussion |
| 🎼 | **Orchestra of subagents** — scout (Haiku) reads and searches, builder (Sonnet) implements, checker (Haiku) runs tests | Subagents have their own cache; the main thread stays lean |
| 🧹 | **Context hygiene** — a new topic in a long context gets a "/clear first" hint with its per-step cost | Dead context stops being re-read on every step |
| 🔁 | **Loop guard** — the same failing test three times, or edit–revert cycles, raise a flag | A stuck agent is the most expensive agent |
| 📊 | **Ledger** — what you spent, what agento saved, cache warmth, weekly-limit pace in the status line | You see the money, not token counts |

## Principles

1. **Never switch the main model mid-task.** The prompt cache does not carry over between models: a switch on a 100k context costs ~$0.23 extra and pays off only after ~10 steps. agento picks models at clean points only — session start, after `/clear` or compaction, cold cache — and in subagents.
2. **Never above your choice.** agento will not raise the model or effort you picked.
3. **Nothing silently.** Every hint shows its reason and an estimate; every automatic action is visible and reversible.
4. **Fail-open.** If agento errors or times out, Claude Code behaves as if it were not installed.
5. **Dollars, not tokens.** Independent studies show "token compression" can *raise* the bill; we measure billed cost per resolved task.

Why: [docs/research.md](docs/research.md) — 87% of a Claude Code bill is prompt cache, not tool output.

## Privacy

`agento audit` and the plugin run locally. No prompts, code or usage leave your machine. A future hosted classifier will be opt-in and receive only compact features.

## Roadmap

- [x] Research and design
- [x] `agento audit` — spend, cache misses, TTL, light tasks on expensive models, subagents, dead context, setup
- [x] Plugin MVP — ledger, status line, subagent routing, loop guard, hints, plan → code handoff, `/agento` pane, autopilot at clean points
- [x] Training pipeline — dataset from your history, L1 judge (any OpenAI-compatible server), replays, public TwinRouterBench labels, [Laya](https://github.com/NandhaKishorM/laya) teacher → multilingual-e5-small student (35 ms on CPU), `agento-brain` daemon
- [ ] Trained System 1 shipped by default instead of rules ([runbook](docs/runbook-gpu.md))
- [ ] Public benchmark: cost per resolved task vs always-Opus, opusplan, rule routers

## Development

```sh
npm install
npm test                 # unit tests (vitest)
npm run typecheck
npm run build && node cli/dist/agento.mjs audit
claude plugin validate plugin && claude plugin test plugin
```

## License

Apache-2.0
