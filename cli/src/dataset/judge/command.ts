// `agento dataset judge`: flag parsing, backend construction, dry run, claude confirmation, the run and the summary.
// cli.ts only wires this in. Everything with side effects is injectable so tests never touch the network or spawn claude.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { detectColor } from '../../report/theme.ts';
import type { Lang } from '../../report/i18n.ts';
import { defaultOutPath } from '../write.ts';
import { isPublicTask, type JudgeTask, type TaskRecord } from '../types.ts';
import { claudeBackend, type SpawnFn } from './claude.ts';
import { estimateRun, type Estimate } from './estimate.ts';
import { judgeStrings } from './i18n.ts';
import { DEFAULT_THRESHOLD } from './label.ts';
import { openAiBackend } from './openai.ts';
import { PROMPT_VERSION } from './prompt.ts';
import { renderConfirm, renderDryRun, renderJudgeSummary } from './render.ts';
import { planRun, runJudge } from './run.ts';
import { defaultJudgePath, judgedMap, readJudgeFile } from './store.ts';
import { summarizeJudge } from './summary.ts';
import type { JudgeBackend, JudgeBackendKind } from './types.ts';

export type Flags = Map<string, string | true>;

export interface JudgeDeps {
  env?: Record<string, string | undefined>;
  stdout?: { write(s: string): unknown; columns?: number; isTTY?: boolean };
  stderr?: { write(s: string): unknown; isTTY?: boolean };
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
  confirm?: (question: string) => Promise<boolean>;
  interactive?: boolean; // stdin is a terminal
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number;
}

export interface JudgeOptions {
  backend: JudgeBackendKind;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  structured: boolean;
  concurrency: number;
  threshold: number;
  maxTasks?: number;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  timeoutMs: number;
  retries: number;
  tasksPath: string;
  outPath: string;
}

function posInt(name: string, v: string | true | undefined, fallback?: number): number | undefined {
  if (v === undefined) return fallback;
  const x = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(x) || x < 1) throw new Error(`--${name}: expected a positive integer`);
  return x;
}

export function parseJudgeFlags(flags: Flags, env: Record<string, string | undefined> = process.env): JudgeOptions {
  const str = (k: string): string | undefined => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
  const backend = str('backend');
  if (backend !== 'openai' && backend !== 'claude') throw new Error('--backend: expected openai or claude');
  const model = str('model');
  if (!model) throw new Error('--model is required');
  const baseUrl = str('base-url');
  if (backend === 'openai' && !baseUrl) throw new Error('--base-url is required for --backend openai');
  const thr = str('threshold');
  const threshold = thr === undefined ? DEFAULT_THRESHOLD : Number(thr);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error('--threshold: expected a number in (0, 1]');
  const maxTasks = posInt('max-tasks', flags.get('max-tasks'));
  const dryRun = flags.has('dry-run');
  if (backend === 'claude' && maxTasks === undefined && !dryRun) {
    throw new Error('--backend claude requires --max-tasks (it spends your subscription limit); use --dry-run to see the estimate first');
  }
  const rt = str('retries');
  const retries = rt === undefined ? 3 : Number(rt);
  if (!Number.isInteger(retries) || retries < 0) throw new Error('--retries: expected a non-negative integer');
  const tasksPath = str('tasks') ?? defaultOutPath(env);
  const out = str('out') ?? defaultJudgePath(backend, model, env);
  return {
    backend,
    model,
    baseUrl,
    apiKeyEnv: str('api-key-env'),
    structured: flags.has('structured'),
    concurrency: posInt('concurrency', flags.get('concurrency'), backend === 'claude' ? 2 : 8)!,
    threshold,
    maxTasks,
    force: flags.has('force'),
    dryRun,
    yes: flags.has('yes'),
    timeoutMs: (posInt('timeout', flags.get('timeout'), 120)! * 1000),
    retries,
    tasksPath,
    outPath: out,
  };
}

function readJsonl(path: string): JudgeTask[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`cannot read ${path}: run \`agento dataset build\` (or \`dataset import\`) first or pass --tasks`);
  }
  const tasks: JudgeTask[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as JudgeTask;
      if (typeof r.taskId === 'string' && Array.isArray(r.text)) tasks.push(r);
    } catch {
      // skip a damaged line
    }
  }
  return tasks;
}

// Own history only (replay needs the observed trajectory).
export function readTasks(path: string): TaskRecord[] {
  return readJsonl(path).filter((t): t is TaskRecord => !isPublicTask(t));
}

// Own history and public records (`dataset import`): the judge accepts both.
export function readJudgeTasks(path: string): JudgeTask[] {
  return readJsonl(path);
}

export function makeBackend(o: JudgeOptions, deps: JudgeDeps = {}): JudgeBackend {
  const env = deps.env ?? process.env;
  if (o.backend === 'claude') return claudeBackend({ model: o.model, timeoutMs: o.timeoutMs, spawnFn: deps.spawnFn });
  let apiKey: string | undefined;
  if (o.apiKeyEnv) {
    apiKey = env[o.apiKeyEnv];
    if (!apiKey) throw new Error(`--api-key-env: environment variable ${o.apiKeyEnv} is empty or not set`);
  }
  return openAiBackend({
    baseUrl: o.baseUrl!,
    model: o.model,
    apiKey,
    structured: o.structured,
    timeoutMs: o.timeoutMs,
    retries: o.retries,
    backoffMs: deps.backoffMs ?? 500,
    fetchFn: deps.fetchFn,
    sleep: deps.sleep,
  });
}

function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(/^\s*(y|yes|д|да)\s*$/i.test(a));
    });
  });
}

export async function datasetJudgeCmd(flags: Flags, lang: Lang, deps: JudgeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const o = parseJudgeFlags(flags, env);
  const D = judgeStrings(lang);
  const color = flags.has('no-color') ? 'none' : detectColor(env, Boolean(stdout.isTTY));
  const width = Math.max(64, Math.min(100, stdout.columns ?? 80));
  const ropts = { color, width, lang };
  const started = Date.now();

  const tasks = readJudgeTasks(o.tasksPath);
  const done = judgedMap(readJudgeFile(o.outPath));
  const plan = planRun(tasks, done, { force: o.force, maxTasks: o.maxTasks });
  const est: Estimate = estimateRun({ backend: o.backend, model: o.model, pending: plan.pending, totalTasks: tasks.length, judgedAlready: plan.alreadyJudged });

  if (o.dryRun) {
    stdout.write(renderDryRun(est, o.outPath, ropts, { claudeWithoutMax: o.backend === 'claude' && o.maxTasks === undefined }) + '\n');
    return 0;
  }

  const backend = makeBackend(o, deps); // validates --api-key-env before anything is spent

  if (o.backend === 'claude' && plan.pending.length > 0) {
    stdout.write(renderConfirm(est, ropts) + '\n');
    if (!o.yes) {
      const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
      if (!interactive && !deps.confirm) {
        stderr.write(`agento: ${D.confirmNeedsYes}\n`);
        return 1;
      }
      const yes = await (deps.confirm ?? askYesNo)(D.confirmPrompt);
      if (!yes) {
        stderr.write(`agento: ${D.confirmDeclined}\n`);
        return 1;
      }
    }
  }

  const tty = Boolean(stderr.isTTY);
  const result = await runJudge({
    tasks,
    outPath: o.outPath,
    backend,
    threshold: o.threshold,
    concurrency: o.concurrency,
    force: o.force,
    maxTasks: o.maxTasks,
    onProgress: (d, t) => {
      if (tty) stderr.write(`\r\x1b[2K◆ agento · ${lang === 'ru' ? 'оцениваю задачи' : 'judging tasks'} ${d}/${t}`);
    },
  });
  if (tty) stderr.write('\r\x1b[2K');

  const summary = summarizeJudge({
    tasks,
    verdicts: judgedMap(readJudgeFile(o.outPath)),
    backend: o.backend,
    model: o.model,
    out: o.outPath,
    threshold: o.threshold,
    promptVersion: PROMPT_VERSION,
    run: result,
    durationMs: Date.now() - started,
  });
  stdout.write(renderJudgeSummary(summary, ropts) + '\n');
  return result.aborted ? 1 : 0;
}
