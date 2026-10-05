// `agento dataset replay`: flag parsing, selection, plan, confirmation, the per-task sandbox + ladder loop, the summary.
// cli.ts only wires this in. Everything with side effects is injectable so tests never spawn claude or touch real worktrees.
//
// THIS SPENDS THE USER'S CLAUDE LIMIT. Guards, in order: --max-tasks and --budget-usd are required; a plan is printed first;
// an interactive confirmation is required unless --yes (no terminal and no --yes: refuse); --dry-run/--select run nothing and
// create no worktree; no run starts when its estimate does not fit the remaining budget; claude itself gets --max-budget-usd.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { detectColor } from '../../report/theme.ts';
import type { Lang } from '../../report/i18n.ts';
import { loadCorpus, resolveProjectsDir, type LoadOptions } from '../../transcripts.ts';
import type { Corpus } from '../../types.ts';
import { makeBackend, readTasks } from '../judge/command.ts';
import { DEFAULT_THRESHOLD, deriveLabel } from '../judge/label.ts';
import { judgedMap, readJudgeFile } from '../judge/store.ts';
import type { JudgeBackend } from '../judge/types.ts';
import { defaultOutPath } from '../write.ts';
import { Cleanup } from './cleanup.ts';
import { makeClaudeRunner, type BashMode, type Runner } from './claude.ts';
import { executeRun, type RunContext } from './exec.ts';
import { createWorktree, installCommand, resetWorktree, runGit, worktreeDiff, type GitFn } from './git.ts';
import { replayStrings } from './i18n.ts';
import { makeDiffJudge } from './judgeDiff.ts';
import { Budget, runLadder } from './ladder.ts';
import { buildPlan, DEFAULT_DAILY_RUNS_SUBSCRIPTION, detectAccount } from './plan.ts';
import { renderConfirm, renderPlan, renderReplaySummary } from './render.ts';
import { DEFAULT_MAX_COMMIT_AGE_MS, l1CheaperSet, selectTasks } from './select.ts';
import { makeShell, type ShellFn } from './shell.ts';
import { buildTaskSources, readFullPrompts, readRawEdits, renderOriginalDiff } from './source.ts';
import { appendJsonl, labelMap, labelsPath, priorRunMap, readLabels, readRuns, replayDir, runsPath, runsToday } from './store.ts';
import { summarizeReplay } from './summary.ts';
import { DEFAULT_LADDER, parseLadder, type ReplayConfig, type RunRecord, type SkipReason } from './types.ts';

export type Flags = Map<string, string | true>;

export interface ReplayDeps {
  env?: Record<string, string | undefined>;
  stdout?: { write(s: string): unknown; columns?: number; isTTY?: boolean };
  stderr?: { write(s: string): unknown; isTTY?: boolean };
  confirm?: (question: string) => Promise<boolean>;
  interactive?: boolean;
  runner?: Runner;
  shell?: ShellFn;
  git?: GitFn;
  corpusLoader?: (o: LoadOptions) => Promise<Corpus>;
  judgeBackend?: JudgeBackend;
  cleanup?: Cleanup;
  installHandlers?: boolean; // default true; tests turn it off
  tmpBase?: string;
  now?: () => number;
}

export interface ReplayOptions {
  select: boolean;
  dryRun: boolean;
  yes: boolean;
  maxTasks?: number;
  budgetUsd?: number;
  ladder: ReplayConfig[];
  samples: number;
  install: boolean;
  preferL1: boolean;
  includeDirty: boolean;
  force: boolean;
  judgeDiff: boolean;
  judgeBackend?: 'openai' | 'claude';
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKeyEnv?: string;
  judgeStructured: boolean;
  judgeFile?: string;
  threshold: number;
  bash: BashMode;
  maxTurns?: number;
  runTimeoutMs: number;
  testTimeoutMs: number;
  maxCommitAgeMs: number;
  maxRunsPerDay?: number;
  tasksPath: string;
  dir?: string; // projects dir
  project?: string;
  outDir: string;
}

const JUDGE_DIFF_EST_USD = 0.05;

function posInt(name: string, v: string | true | undefined, fallback?: number): number | undefined {
  if (v === undefined) return fallback;
  const x = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(x) || x < 1) throw new Error(`--${name}: expected a positive integer`);
  return x;
}

export function parseReplayFlags(flags: Flags, env: Record<string, string | undefined> = process.env, lang: Lang = 'en'): ReplayOptions {
  const D = replayStrings(lang);
  const str = (k: string): string | undefined => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
  const select = flags.has('select');
  const dryRun = flags.has('dry-run');
  const maxTasks = posInt('max-tasks', flags.get('max-tasks'));
  if (maxTasks === undefined && !select) throw new Error(D.needMaxTasks);
  const budgetRaw = str('budget-usd');
  let budgetUsd: number | undefined;
  if (budgetRaw !== undefined) {
    budgetUsd = Number(budgetRaw);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('--budget-usd: expected a positive number');
  }
  if (budgetUsd === undefined && !select) throw new Error(D.needBudget);
  const ladderSpec = str('ladder');
  const bash = str('bash') ?? 'safe';
  if (bash !== 'safe' && bash !== 'all' && bash !== 'none') throw new Error('--bash: expected safe, all or none');
  const thr = str('threshold');
  const threshold = thr === undefined ? DEFAULT_THRESHOLD : Number(thr);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error('--threshold: expected a number in (0, 1]');
  const judgeDiff = flags.has('judge-diff');
  const judgeBackend = str('judge-backend');
  if (judgeBackend !== undefined && judgeBackend !== 'openai' && judgeBackend !== 'claude') throw new Error('--judge-backend: expected openai or claude');
  if (judgeDiff) {
    if (!judgeBackend) throw new Error('--judge-diff needs --judge-backend <openai|claude> and --judge-model');
    if (!str('judge-model')) throw new Error('--judge-diff needs --judge-model');
    if (judgeBackend === 'openai' && !str('judge-base-url')) throw new Error('--judge-backend openai needs --judge-base-url');
  }
  const age = str('max-commit-age-days');
  const ageDays = age === undefined ? undefined : Number(age);
  if (ageDays !== undefined && (!Number.isFinite(ageDays) || ageDays <= 0)) throw new Error('--max-commit-age-days: expected a positive number');
  return {
    select,
    dryRun,
    yes: flags.has('yes'),
    maxTasks,
    budgetUsd,
    ladder: ladderSpec ? parseLadder(ladderSpec) : [...DEFAULT_LADDER],
    samples: posInt('samples', flags.get('samples'), 2)!,
    install: flags.has('install'),
    preferL1: flags.has('prefer-l1-disagreement'),
    includeDirty: flags.has('include-dirty'),
    force: flags.has('force'),
    judgeDiff,
    judgeBackend: judgeBackend as 'openai' | 'claude' | undefined,
    judgeModel: str('judge-model'),
    judgeBaseUrl: str('judge-base-url'),
    judgeApiKeyEnv: str('judge-api-key-env'),
    judgeStructured: flags.has('structured'),
    judgeFile: str('judge-file'),
    threshold,
    bash,
    maxTurns: posInt('max-turns', flags.get('max-turns')),
    runTimeoutMs: posInt('run-timeout', flags.get('run-timeout'), 1200)! * 1000,
    testTimeoutMs: posInt('test-timeout', flags.get('test-timeout'), 600)! * 1000,
    maxCommitAgeMs: ageDays === undefined ? DEFAULT_MAX_COMMIT_AGE_MS : ageDays * 86_400_000,
    maxRunsPerDay: posInt('max-runs-per-day', flags.get('max-runs-per-day')),
    tasksPath: str('tasks') ?? defaultOutPath(env),
    dir: str('dir'),
    project: str('project'),
    outDir: str('out-dir') ?? replayDir(env),
  };
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

// The newest judge file in $AGENTO_HOME/dataset/judge, unless --judge-file names one.
function findJudgeFile(explicit: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (explicit) return explicit;
  const dir = join(env.AGENTO_HOME || join(process.env.HOME ?? '', '.agento'), 'dataset', 'judge');
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && f !== 'human.jsonl').map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }));
    return files.sort((a, b) => b.m - a.m)[0]?.f;
  } catch {
    return undefined;
  }
}

export async function datasetReplayCmd(flags: Flags, lang: Lang, deps: ReplayDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? Date.now;
  const git = deps.git ?? runGit;
  const D = replayStrings(lang);
  const o = parseReplayFlags(flags, env, lang);
  const color = flags.has('no-color') ? 'none' : detectColor(env, Boolean(stdout.isTTY));
  const width = Math.max(64, Math.min(100, stdout.columns ?? 80));
  const ropts = { color, width, lang };
  const started = now();
  const tty = Boolean(stderr.isTTY);

  const tasks = readTasks(o.tasksPath);
  const projectsDir = resolveProjectsDir(o.dir);
  const progress = (d: number, t: number): void => {
    if (tty) stderr.write(`\r\x1b[2K◆ agento · ${lang === 'ru' ? 'читаю транскрипты' : 'reading transcripts'} ${d}/${t}`);
  };
  const corpus = await (deps.corpusLoader ?? loadCorpus)({ dir: projectsDir, project: o.project, onProgress: progress });
  if (tty) stderr.write('\r\x1b[2K');
  const sources = buildTaskSources(corpus);

  const labels = labelMap(readLabels(o.outDir));
  const priorRuns = readRuns(o.outDir);

  const judgeFile = findJudgeFile(o.judgeFile, env);
  const verdicts = judgeFile ? judgedMap(readJudgeFile(judgeFile)) : new Map();
  const l1Config = new Map<string, string>();
  for (const [id, v] of verdicts) {
    const l = deriveLabel(v.l1Probs, o.threshold);
    l1Config.set(id, `${l.tier}-${l.effort}`);
  }
  const order = [...o.ladder.map((c) => c.id), ...DEFAULT_LADDER.map((c) => c.id)];

  const sel = selectTasks({
    tasks,
    sources,
    labeled: o.force ? new Set() : new Set(labels.keys()),
    ladder: o.ladder,
    includeDirty: o.includeDirty,
    maxCommitAgeMs: o.maxCommitAgeMs,
    l1Cheaper: o.preferL1 ? l1CheaperSet(tasks, l1Config, order) : undefined,
    git,
  });
  const picked = sel.candidates.slice(0, o.maxTasks ?? sel.candidates.length);

  const judgePerRun = o.judgeDiff && o.judgeBackend === 'claude' ? JUDGE_DIFF_EST_USD : 0;
  const dailyCap = o.maxRunsPerDay ?? DEFAULT_DAILY_RUNS_SUBSCRIPTION;
  const plan =
    o.budgetUsd === undefined
      ? undefined
      : buildPlan({ candidates: picked, ladder: o.ladder, samples: o.samples, budgetUsd: o.budgetUsd, env, judgePerRunUsd: judgePerRun, dailyCap });

  if (o.select || o.dryRun) {
    stdout.write(
      renderPlan({ mode: o.select ? 'select' : 'dry-run', totalTasks: tasks.length, selectedTotal: sel.candidates.length, candidates: picked, skippedByReason: sel.skippedByReason, dirty: sel.dirty, plan: o.select ? undefined : plan, judgeDiff: o.judgeDiff }, ropts) + '\n',
    );
    return 0; // nothing executed, no worktree created
  }
  if (!plan) return 1; // unreachable: --budget-usd is required without --select
  const budgetUsd = o.budgetUsd!;

  if (picked.length === 0) {
    stdout.write(renderPlan({ mode: 'dry-run', totalTasks: tasks.length, selectedTotal: 0, candidates: [], skippedByReason: sel.skippedByReason, dirty: sel.dirty, judgeDiff: o.judgeDiff }, ropts) + '\n');
    return 0;
  }

  // judge backend is built before anything is spent so a bad --judge-api-key-env fails early
  let judgeBackend: JudgeBackend | undefined = deps.judgeBackend;
  if (o.judgeDiff && !judgeBackend) {
    judgeBackend = makeBackend({
      backend: o.judgeBackend!,
      model: o.judgeModel!,
      baseUrl: o.judgeBaseUrl,
      apiKeyEnv: o.judgeApiKeyEnv,
      structured: o.judgeStructured,
      concurrency: 1,
      threshold: o.threshold,
      force: false,
      dryRun: false,
      yes: true,
      timeoutMs: 180_000,
      retries: 2,
      tasksPath: o.tasksPath,
      outPath: '',
    });
  }

  // ───────── confirmation ─────────
  stdout.write(renderConfirm(plan, ropts) + '\n');
  if (!o.yes) {
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
    if (!interactive && !deps.confirm) {
      stderr.write(`agento: ${D.confirmNeedsYes}\n`);
      return 1;
    }
    if (!(await (deps.confirm ?? askYesNo)(D.confirmPrompt))) {
      stderr.write(`agento: ${D.confirmDeclined}\n`);
      return 1;
    }
  }

  // ───────── run ─────────
  const cleanup = deps.cleanup ?? new Cleanup();
  const uninstall = deps.installHandlers === false ? undefined : cleanup.install();
  const base = deps.tmpBase ?? mkdtempSync(join(tmpdir(), 'agento-replay-'));
  mkdirSync(base, { recursive: true });
  const disposeBase = cleanup.add(() => rmSync(base, { recursive: true, force: true }));
  const runner = deps.runner ?? makeClaudeRunner({ cleanup, env });
  const shell = deps.shell ?? makeShell(cleanup);
  const account = detectAccount(env);
  const runsLeft = account === 'api-key' && o.maxRunsPerDay === undefined ? Infinity : Math.max(0, dailyCap - runsToday(priorRuns, now()));
  const budget = new Budget(budgetUsd, runsLeft);
  const prior = o.force ? new Map<string, RunRecord>() : priorRunMap(priorRuns);
  const newRuns: RunRecord[] = [];
  let replayed = 0;
  let labeledNow = 0;
  let inconclusive = 0;
  let stopped: string | undefined;
  let consecutiveErrors = 0;
  let failed = false;
  const progressTask = (i: number): void => {
    if (tty) stderr.write(`\r\x1b[2K◆ agento · ${lang === 'ru' ? 'повторяю задачи' : 'replaying tasks'} ${i}/${picked.length}`);
  };

  try {
    let idx = 0;
    for (const cand of picked) {
      progressTask(idx++);
      const src = sources.get(cand.taskId)!;
      const wt = createWorktree(cand.repoRoot, base, cand.taskId, cand.commit, git);
      const dispose = cleanup.add(() => wt.remove());
      try {
        const runDir = cand.relCwd ? join(wt.path, cand.relCwd) : wt.path;
        if (o.install) {
          const cmd = installCommand(wt.path);
          if (cmd) await shell(cmd, { cwd: wt.path, timeoutMs: 15 * 60_000 });
        }
        let testBaseline: 'pass' | 'fail' | undefined;
        if (cand.testCommand) {
          const r = await shell(cand.testCommand.command, { cwd: wt.path, timeoutMs: o.testTimeoutMs });
          testBaseline = r.code === 0 ? 'pass' : 'fail';
          resetWorktree(wt, git);
        }
        const prompts = await readFullPrompts(projectsDir, src);
        const judgeTask = (tasks.find((t) => t.taskId === cand.taskId)?.text ?? []).join('\n');
        const originalDiff = o.judgeDiff && judgeBackend ? renderOriginalDiff(await readRawEdits(projectsDir, src), cand.repoRoot) : '';
        const ctx: RunContext = {
          taskId: cand.taskId,
          prompts,
          runDir,
          testDir: wt.path,
          testCommand: cand.testCommand?.command,
          testBaseline,
          originalEdited: cand.originalEdited,
          bash: o.bash,
          maxTurns: o.maxTurns,
          runTimeoutMs: o.runTimeoutMs,
          testTimeoutMs: o.testTimeoutMs,
          runner,
          shell,
          diff: () => worktreeDiff(wt, 60_000, git),
          reset: () => resetWorktree(wt, git),
          ...(o.judgeDiff && judgeBackend && originalDiff ? { judge: { fn: makeDiffJudge(judgeBackend), task: judgeTask, originalDiff } } : {}),
          now,
        };
        const priorCost = priorRuns.filter((r) => r.taskId === cand.taskId).reduce((a, r) => a + r.costUsd + (r.judgeCostUsd ?? 0), 0);
        let ranHere = 0;
        const out = await runLadder({
          taskId: cand.taskId,
          ladder: o.ladder,
          samples: o.samples,
          budget,
          estimate: (c) => (cand.estUsd[c.id] ?? 0) + (cand.originalEdited ? judgePerRun : 0),
          execute: (c, s, cap) => executeRun(ctx, c, s, cap),
          onRun: (r) => {
            appendJsonl(runsPath(o.outDir), r);
            newRuns.push(r);
            ranHere += 1;
            consecutiveErrors = r.status === 'error' ? consecutiveErrors + 1 : 0;
          },
          prior,
          priorCostUsd: priorCost,
          evidence: { testCommand: cand.testCommand?.command, testBaseline, originalEdited: cand.originalEdited, judge: Boolean(ctx.judge), commit: cand.commit },
          now,
        });
        if (ranHere > 0) replayed += 1;
        if (out.kind === 'labeled') {
          appendJsonl(labelsPath(o.outDir), out.label);
          labels.set(out.label.taskId, out.label);
          labeledNow += 1;
        } else if (out.kind === 'stopped') {
          stopped = out.reason === 'budget' ? (lang === 'ru' ? 'следующий прогон не влезает в остаток бюджета' : 'the next run does not fit the remaining budget') : lang === 'ru' ? 'достигнут суточный лимит прогонов' : 'daily run cap reached';
        } else {
          inconclusive += 1;
          if (consecutiveErrors >= 3) {
            stopped = `claude failed ${consecutiveErrors} times in a row: ${out.reason}`;
            failed = true;
          }
        }
      } finally {
        dispose();
      }
      if (stopped) break;
    }
  } finally {
    if (tty) stderr.write('\r\x1b[2K');
    cleanup.runAll();
    disposeBase();
    uninstall?.();
  }

  const summary = summarizeReplay({
    tasks,
    labels,
    thisRun: { selected: picked.length, replayed, labeledNow, inconclusive, skipped: sel.skippedByReason as Partial<Record<SkipReason, number>>, stopped, runs: newRuns },
    l1: judgeFile ? { file: judgeFile, threshold: o.threshold, verdicts } : undefined,
    dir: o.outDir,
    budgetUsd,
    durationMs: now() - started,
  });
  stdout.write(renderReplaySummary(summary, ropts, { runs: runsPath(o.outDir), labels: labelsPath(o.outDir) }) + '\n');
  return failed ? 1 : 0;
}
