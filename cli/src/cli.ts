import { writeFileSync } from 'node:fs';
import { loadCorpus, resolveProjectsDir } from './transcripts.ts';
import { buildReport } from './audit/index.ts';
import { detectColor, renderJson, renderMarkdown, renderTerminal } from './report/index.ts';
import { buildDataset, renderDatasetSummary } from './dataset/index.ts';
import { datasetJudgeCmd } from './dataset/judge/index.ts';
import { datasetReplayCmd } from './dataset/replay/index.ts';

const VERSION = '0.1.0';

const HELP = `agento — spend less of your Claude Code budget without losing quality

Usage
  agento audit [options]     analyze local Claude Code transcripts
  agento dataset build [options]   build the training dataset (tasks.jsonl) from local transcripts
  agento dataset judge [options]   L1 labels: a judge model reads each finished task (resumable)
  agento dataset replay [options]  L2 labels: re-run past tasks on cheaper configurations in a git worktree (SPENDS your limit)
  agento --version

Audit options
  --dir <path>        projects dir (default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
  --since <30d|2w|YYYY-MM-DD>   only recent activity (default: 30d; "all" for everything)
  --project <text>    only projects whose directory name contains <text>
  --json              print the report as JSON
  --md <file>         also write a Markdown report to <file>
  --lang <ru|en>      report language (default: from $LANG)
  --no-color          disable colors

Dataset build options (--dir, --project, --lang, --no-color as above)
  --since <all|30d|2w|YYYY-MM-DD>   default: all
  --out <file>        default: $AGENTO_HOME/dataset/tasks.jsonl (AGENTO_HOME defaults to ~/.agento)

Dataset judge options (--lang, --no-color as above); input: $AGENTO_HOME/dataset/tasks.jsonl, output: $AGENTO_HOME/dataset/judge/<backend>-<model>.jsonl
  --backend <openai|claude>   openai: any OpenAI-compatible chat endpoint (e.g. vLLM); claude: \`claude -p\` (spends your subscription limit)
  --model <name>      model name for openai; haiku, sonnet or opus for claude
  --base-url <url>    openai only, e.g. http://gpu-box:8000/v1
  --api-key-env <VAR> openai only: environment variable that holds the API key
  --structured        openai only: response_format json_schema (vLLM guided JSON); default: ask for JSON and parse it
  --concurrency <N>   parallel requests (default: 8 for openai, 2 for claude)
  --threshold <p>     L1 label = cheapest configuration with p >= threshold (default: 0.7), else opus·medium
  --max-tasks <N>     judge at most N pending tasks (required for claude)
  --timeout <sec>     per-request timeout (default: 120)
  --retries <N>       openai: retries with backoff on network errors, 429 and 5xx (default: 3)
  --tasks <file>      input file (default: $AGENTO_HOME/dataset/tasks.jsonl)
  --out <file>        output file (default: see above)
  --force             judge again tasks that already have a verdict
  --yes               claude: do not ask for confirmation
  --dry-run           print task count, token and cost estimates; call nothing

Dataset replay options (--lang, --no-color, --dir, --project, --tasks as above); output: $AGENTO_HOME/dataset/replay/{runs,labels}.jsonl
  THIS SPENDS YOUR CLAUDE LIMIT (subscription) or MONEY (ANTHROPIC_API_KEY). Nothing runs without --max-tasks, --budget-usd and a confirmation.
  --max-tasks <N>     replay at most N tasks (required)
  --budget-usd <X>    stop before a run whose estimate does not fit the remaining budget (required)
  --yes               do not ask for confirmation (without a terminal and without --yes: refuse)
  --dry-run           print the selection and the plan (tasks x ladder x samples, cost range, account); run nothing, create no worktree
  --select            print only the selection and skip reasons
  --ladder <list>     default haiku-low,sonnet-medium,sonnet-high,opus-medium (tier-effort, comma separated)
  --samples <N>       runs per configuration, all must pass (default: 2)
  --install           install dependencies in the worktree from the lockfile (default: off)
  --prefer-l1-disagreement   prioritize tasks where the L1 judge says cheaper than what ran
  --include-dirty     also replay tasks whose working tree was dirty at the start (default: skipped)
  --judge-diff        also ask a judge to compare the replay diff with the original (--judge-backend <openai|claude> --judge-model <m>
                      [--judge-base-url <url>] [--judge-api-key-env VAR] [--structured])
  --judge-file <file> L1 judge file for the L1 vs L2 comparison (default: newest in $AGENTO_HOME/dataset/judge)
  --threshold <p>     L1 threshold when re-deriving labels (default: 0.7)
  --bash <safe|all|none>   Bash for the replayed agent: test command + read-only (default), everything (unsandboxed!), nothing
  --run-timeout <sec> per run (default: 1200)   --test-timeout <sec> per test command (default: 600)
  --max-turns <N>     pass --max-turns to claude (not listed by this claude's --help, so only on request)
  --max-commit-age-days <N>   skip tasks whose nearest earlier commit is older (default: 14)
  --max-runs-per-day <N>      daily run cap (default: 40 without an API key)
  --out-dir <dir>     default: $AGENTO_HOME/dataset/replay
  --force             ignore existing labels and earlier runs
`;

interface Args {
  cmd?: string;
  sub?: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  let cmd: string | undefined;
  let sub: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (inline !== undefined) flags.set(k, inline);
      else if (next !== undefined && !next.startsWith('--') && VALUED.has(k)) flags.set(k, argv[++i]!);
      else flags.set(k, true);
    } else if (a === '-h') flags.set('help', true);
    else if (a === '-v') flags.set('version', true);
    else if (cmd === undefined) cmd = a;
    else sub ??= a;
  }
  return { cmd, sub, flags };
}

const VALUED = new Set(['dir', 'since', 'project', 'md', 'lang', 'out', 'backend', 'base-url', 'model', 'api-key-env', 'concurrency', 'threshold', 'max-tasks', 'timeout', 'retries', 'tasks', 'ladder', 'samples', 'budget-usd', 'judge-backend', 'judge-model', 'judge-base-url', 'judge-api-key-env', 'judge-file', 'run-timeout', 'test-timeout', 'max-turns', 'bash', 'max-commit-age-days', 'max-runs-per-day', 'out-dir']);

export function parseSince(v: string | undefined, now = Date.now()): number | undefined {
  if (v === undefined) return now - 30 * 86_400_000;
  if (v === 'all') return undefined;
  const rel = /^(\d+)([dw])$/.exec(v);
  if (rel) return now - Number(rel[1]) * (rel[2] === 'w' ? 7 : 1) * 86_400_000;
  const abs = Date.parse(v);
  if (!Number.isNaN(abs)) return abs;
  throw new Error(`--since: expected 30d, 2w, YYYY-MM-DD or all, got "${v}"`);
}

function detectLang(flag: string | undefined): 'ru' | 'en' {
  if (flag === 'ru' || flag === 'en') return flag;
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return /^ru/i.test(env) ? 'ru' : 'en';
}

async function audit(flags: Map<string, string | true>): Promise<void> {
  const str = (k: string) => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
  const dir = resolveProjectsDir(str('dir'));
  const sinceArg = str('since');
  const since = parseSince(sinceArg);
  const lang = detectLang(str('lang'));
  const json = flags.has('json');
  const tty = Boolean(process.stderr.isTTY) && !json;

  const progress = (done: number, total: number) => {
    if (!tty) return;
    const label = lang === 'ru' ? 'читаю транскрипты' : 'reading transcripts';
    process.stderr.write(`\r\x1b[2K◆ agento · ${label} ${done}/${total}`);
  };
  const corpus = await loadCorpus({ dir, since, project: str('project'), onProgress: progress });
  if (tty) process.stderr.write('\r\x1b[2K');

  const report = buildReport(corpus, { lang, since: sinceArg ?? '30d' });

  if (json) {
    process.stdout.write(renderJson(report) + '\n');
  } else {
    const color = flags.has('no-color') ? 'none' : detectColor(process.env, Boolean(process.stdout.isTTY));
    const width = Math.max(64, Math.min(100, process.stdout.columns ?? 80));
    process.stdout.write(renderTerminal(report, { color, width }) + '\n');
  }
  const md = str('md');
  if (md) writeFileSync(md, renderMarkdown(report));
}

async function datasetBuildCmd(flags: Map<string, string | true>): Promise<void> {
  const str = (k: string) => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
  const dir = resolveProjectsDir(str('dir'));
  const sinceLabel = str('since') ?? 'all';
  const since = parseSince(sinceLabel);
  const lang = detectLang(str('lang'));
  const tty = Boolean(process.stderr.isTTY);
  const progress = (done: number, total: number) => {
    if (!tty) return;
    const label = lang === 'ru' ? 'читаю транскрипты' : 'reading transcripts';
    process.stderr.write(`\r\x1b[2K◆ agento · ${label} ${done}/${total}`);
  };
  const result = await buildDataset({ dir, since, sinceLabel, project: str('project'), out: str('out'), onProgress: progress });
  if (tty) process.stderr.write('\r\x1b[2K');
  const color = flags.has('no-color') ? 'none' : detectColor(process.env, Boolean(process.stdout.isTTY));
  const width = Math.max(64, Math.min(100, process.stdout.columns ?? 80));
  process.stdout.write(renderDatasetSummary(result.summary, { color, width, lang }) + '\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { cmd, sub, flags } = parseArgs(argv);
  if (flags.has('version')) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (!cmd || flags.has('help') || cmd === 'help') {
    process.stdout.write(HELP);
    return cmd || flags.has('help') ? 0 : 1;
  }
  if (cmd === 'audit') {
    await audit(flags);
    return 0;
  }
  if (cmd === 'dataset' && sub === 'build') {
    await datasetBuildCmd(flags);
    return 0;
  }
  if (cmd === 'dataset' && sub === 'judge') {
    return datasetJudgeCmd(flags, detectLang(typeof flags.get('lang') === 'string' ? (flags.get('lang') as string) : undefined));
  }
  if (cmd === 'dataset' && sub === 'replay') {
    return datasetReplayCmd(flags, detectLang(typeof flags.get('lang') === 'string' ? (flags.get('lang') as string) : undefined));
  }
  if (cmd === 'dataset') {
    process.stderr.write(`agento: unknown dataset command "${sub ?? ''}" (expected: build, judge, replay)\n\n${HELP}`);
    return 1;
  }
  process.stderr.write(`agento: unknown command "${cmd}"\n\n${HELP}`);
  return 1;
}
