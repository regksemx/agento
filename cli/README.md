# agento-cc

The command-line half of [agento](https://github.com/regksemx/agento): see where your Claude Code budget goes, then spend less of it without losing quality.

```sh
npx agento-cc audit            # last 30 days
npx agento-cc audit --since all --md report.md
```

The audit reads the transcripts Claude Code already keeps on your disk (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR`) and prices every request at API list rates: by model, project, cache miss and task. Then it lists what to change, each item with an estimate. Nothing is sent anywhere. Node 20 or newer.

The other half is a Claude Code plugin that acts on that list inside Claude Code, and only where switching models costs nothing:

```text
/plugin marketplace add regksemx/agento
/plugin install agento@agento
```

## Commands

| Command | What it does |
|---|---|
| `agento audit [--since 30d\|all] [--md file] [--json]` | Spend, cache misses and their causes, TTL, light tasks on expensive models, subagents, dead context, setup |
| `agento dataset build` | Cuts transcripts into tasks with features and weak labels; scrubs secrets into `~/.agento/dataset/tasks.jsonl` |
| `agento dataset judge` | A judge reads each finished task: any OpenAI-compatible server (e.g. vLLM) or `claude -p` |
| `agento dataset label` | You label a sample of your own past tasks in the terminal |
| `agento dataset replay` | Re-runs past tasks on cheaper setups in a git worktree (spends your limit; takes `--budget-usd`) |
| `agento dataset import twinrouterbench` | Public verified-tier labels from TwinRouterBench |
| `agento dataset validate-judge` | Compares a judge with the public labels |

Amounts are API-equivalent. On a subscription nothing is charged per token; the real constraint is the weekly limit, and the audit says so.

How it works, with the author's own numbers: [regksemx.github.io/agento](https://regksemx.github.io/agento/). Apache-2.0. Not affiliated with Anthropic.
