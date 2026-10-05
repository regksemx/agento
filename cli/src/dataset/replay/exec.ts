// One replay run and its verification. Everything with side effects is injected (runner, shell, diff, reset, judge),
// so tests drive it with mocks and never spawn claude.

import type { DiffInfo } from './git.ts';
import type { DiffJudgeFn } from './judgeDiff.ts';
import type { BashMode, Runner } from './claude.ts';
import { composePrompt } from './claude.ts';
import type { ShellFn } from './shell.ts';
import { REPLAY_SCHEMA_VERSION, type CheckState, type ReplayConfig, type RunChecks, type RunRecord } from './types.ts';

export interface RunContext {
  taskId: string;
  prompts: readonly string[]; // original prompts, in memory only
  runDir: string; // worktree (+ the session's sub-directory)
  testDir: string; // where the test command runs
  testCommand?: string;
  testBaseline?: 'pass' | 'fail'; // the command on the starting commit, before any replay
  originalEdited: boolean;
  bash: BashMode;
  maxTurns?: number;
  runTimeoutMs: number;
  testTimeoutMs: number;
  runner: Runner;
  shell: ShellFn;
  diff: () => DiffInfo;
  reset: () => void;
  judge?: { fn: DiffJudgeFn; task: string; originalDiff: string };
  now?: () => number;
}

export function allPass(checks: RunChecks): boolean {
  const states = Object.values(checks);
  const evaluated = states.filter((s) => s === 'pass' || s === 'fail' || s === 'error');
  return evaluated.length > 0 && evaluated.every((s) => s === 'pass');
}

// The checks that apply to this task at all (used for the label's evidence).
export function applicableChecks(c: { testCommand?: string; testBaseline?: 'pass' | 'fail'; originalEdited: boolean; judge: boolean }): Array<keyof RunChecks> {
  const out: Array<keyof RunChecks> = [];
  if (c.testCommand && c.testBaseline === 'pass') out.push('tests');
  if (c.originalEdited) out.push('diff');
  if (c.originalEdited && c.judge) out.push('judge');
  return out;
}

export async function executeRun(ctx: RunContext, cfg: ReplayConfig, sample: number, maxBudgetUsd: number): Promise<RunRecord> {
  const now = ctx.now ?? Date.now;
  const base = { v: REPLAY_SCHEMA_VERSION, taskId: ctx.taskId, config: cfg.id, tier: cfg.tier, effort: cfg.effort, sample } as const;
  const checks: RunChecks = { tests: 'skipped', diff: 'skipped', judge: 'skipped' };
  try {
    const res = await ctx.runner({
      tier: cfg.tier,
      effort: cfg.effort,
      prompt: composePrompt(ctx.prompts),
      cwd: ctx.runDir,
      maxBudgetUsd,
      timeoutMs: ctx.runTimeoutMs,
      bash: ctx.bash,
      testCommand: ctx.testCommand,
      maxTurns: ctx.maxTurns,
    });
    const common = { ...base, ts: now(), costUsd: res.costUsd, numTurns: res.numTurns, durationMs: res.durationMs };
    if (res.kind === 'error') return { ...common, status: 'error', error: res.error, checks, pass: false };
    if (res.kind === 'timeout') return { ...common, status: 'timeout', error: res.error, checks, pass: false };
    if (res.isError) {
      // the agent ran out of budget/turns or failed: a verdict on the configuration, no point verifying
      return { ...common, status: 'ok', agentError: res.subtype ?? 'error', checks, pass: false };
    }

    let diffFiles: number | undefined;
    let diffLines: number | undefined;
    let patch = '';
    let judgeCost: number | undefined;

    // 1. diff (cheap): only for tasks that edited files
    const d = ctx.diff();
    diffFiles = d.files;
    diffLines = d.lines;
    patch = d.patch;
    if (ctx.originalEdited) checks.diff = d.files > 0 ? 'pass' : 'fail';

    // 2. recorded test command, but only when it was green before the replay (otherwise it says nothing about the agent)
    if (ctx.testCommand) {
      if (ctx.testBaseline !== 'pass') checks.tests = 'unavailable';
      else if (checks.diff === 'fail') checks.tests = 'skipped';
      else {
        const t = await ctx.shell(ctx.testCommand, { cwd: ctx.testDir, timeoutMs: ctx.testTimeoutMs });
        checks.tests = t.code === 0 ? 'pass' : 'fail';
      }
    }

    // 3. judge with the reference diff: the dearest check, only when everything else passed
    if (ctx.judge && ctx.originalEdited && checks.diff === 'pass' && checks.tests !== 'fail') {
      const v = await ctx.judge.fn(ctx.judge.task, ctx.judge.originalDiff, patch);
      checks.judge = v === 'error' ? 'error' : v.pass ? 'pass' : 'fail';
      if (v !== 'error') judgeCost = v.costUsd;
    }
    return {
      ...common,
      status: 'ok',
      checks,
      pass: allPass(checks),
      ...(judgeCost ? { judgeCostUsd: judgeCost } : {}),
      diffFiles,
      diffLines,
    };
  } finally {
    ctx.reset();
  }
}

export type { CheckState };
