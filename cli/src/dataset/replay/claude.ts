// The replay runner: `claude -p` in a worktree. Flags checked against `claude --help` (2.1.x):
//   -p, --model <alias>, --effort <low|medium|high|xhigh|max>, --permission-mode acceptEdits, --output-format json,
//   --no-session-persistence, --max-budget-usd <n>, --allowed-tools <list>. The working directory is the spawn cwd.
// `--max-turns` is NOT listed by this version's help, so it is passed only when the user asks for it (--max-turns N).
// The prompt goes in on stdin: it never appears in the process list and is never written to disk by agento.

import { spawn as nodeSpawn } from 'node:child_process';
import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';
import type { Cleanup } from './cleanup.ts';

export type BashMode = 'safe' | 'all' | 'none';

export interface RunRequest {
  tier: TaskTier;
  effort: TaskEffort;
  prompt: string;
  cwd: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  bash: BashMode;
  testCommand?: string;
  maxTurns?: number;
}

export interface RunResult {
  kind: 'result' | 'timeout' | 'error';
  isError: boolean; // claude reported is_error
  subtype?: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  error?: string;
}

export type Runner = (req: RunRequest) => Promise<RunResult>;

const SAFE_READ_ONLY = ['git status', 'git diff', 'git log', 'git show', 'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'pwd'];

export function allowedTools(bash: BashMode, testCommand?: string): string {
  const tools = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'];
  if (bash === 'all') tools.push('Bash');
  else if (bash === 'safe') {
    if (testCommand) tools.push(`Bash(${testCommand}:*)`);
    for (const c of SAFE_READ_ONLY) tools.push(`Bash(${c}:*)`);
  }
  return tools.join(',');
}

export function claudeRunArgs(r: RunRequest): string[] {
  return [
    '-p',
    '--model',
    r.tier,
    '--effort',
    r.effort,
    '--permission-mode',
    'acceptEdits',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-budget-usd',
    r.maxBudgetUsd.toFixed(2),
    '--allowed-tools',
    allowedTools(r.bash, r.testCommand),
    ...(r.maxTurns !== undefined ? ['--max-turns', String(r.maxTurns)] : []),
  ];
}

interface ClaudeJson {
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  result?: unknown;
}

// A JSON result object means claude ran (even when it reports an error). Anything else is infrastructure.
export function parseRunOutput(stdout: string, wallMs: number): RunResult {
  let j: ClaudeJson;
  try {
    const parsed: unknown = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    j = parsed as ClaudeJson;
  } catch {
    return { kind: 'error', isError: true, costUsd: 0, numTurns: 0, durationMs: wallMs, error: 'output is not JSON' };
  }
  const cost = typeof j.total_cost_usd === 'number' && Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : 0;
  const turns = typeof j.num_turns === 'number' ? j.num_turns : 0;
  const isError = j.is_error === true;
  // An error that never got going (auth, credit, bad flag): no cost, no turns. Not a verdict on the configuration.
  if (isError && cost === 0 && turns <= 1) {
    const why = typeof j.result === 'string' ? j.result.slice(0, 120) : (j.subtype ?? 'error');
    return { kind: 'error', isError, subtype: j.subtype, costUsd: 0, numTurns: turns, durationMs: wallMs, error: why };
  }
  return { kind: 'result', isError, subtype: j.subtype, costUsd: cost, numTurns: turns, durationMs: typeof j.duration_ms === 'number' ? j.duration_ms : wallMs };
}

export interface RunnerOptions {
  bin?: string;
  spawnFn?: typeof nodeSpawn;
  cleanup?: Cleanup;
  env?: Record<string, string | undefined>;
}

export function makeClaudeRunner(o: RunnerOptions = {}): Runner {
  const spawnFn = o.spawnFn ?? nodeSpawn;
  const bin = o.bin ?? 'claude';
  return (req) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawnFn(bin, claudeRunArgs(req), { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...(o.env ?? process.env) } as NodeJS.ProcessEnv });
      let out = '';
      let err = '';
      let done = false;
      let timedOut = false;
      const killGroup = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // gone
          }
        }
      };
      const dispose = o.cleanup?.add(killGroup);
      const finish = (r: RunResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        dispose?.();
        resolve(r);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, req.timeoutMs);
      child.stdout?.on('data', (d: Buffer | string) => (out += d.toString()));
      child.stderr?.on('data', (d: Buffer | string) => (err += d.toString()));
      child.on('error', (e: Error) => finish({ kind: 'error', isError: true, costUsd: 0, numTurns: 0, durationMs: Date.now() - started, error: `claude: ${e.message}` }));
      child.on('close', (code: number | null) => {
        const wall = Date.now() - started;
        if (timedOut) {
          // the cost of a killed run is unknown; the budget cap (--max-budget-usd) bounds it
          return finish({ kind: 'timeout', isError: true, costUsd: 0, numTurns: 0, durationMs: wall, error: `timeout after ${Math.round(req.timeoutMs / 1000)} s` });
        }
        const r = parseRunOutput(out, wall);
        if (r.kind === 'error' && code !== 0 && !r.error?.startsWith('claude')) r.error = `exit ${code}${err ? `: ${err.trim().slice(0, 120)}` : ''}`;
        finish(r);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.write(req.prompt);
      child.stdin?.end();
    });
}

// The replayed prompt: the original text; bare confirmations that followed it are appended once, because `-p` has no second turn.
export function composePrompt(prompts: readonly string[]): string {
  const [first = '', ...rest] = prompts;
  if (rest.length === 0) return first;
  return `${first}\n\n(Later messages from the user in this task: ${rest.map((p) => `"${p.trim()}"`).join(', ')}. Proceed without asking for confirmation.)`;
}
