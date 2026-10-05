// Which tasks can be replayed at all. Pure apart from the injected git functions; reasons are counted, never silently dropped.

import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { TaskRecord } from '../types.ts';
import { commitBefore, detectDirtyStart, detectTestCommand, realPath, repoRoot, resolveBranch, runGit, type GitFn } from './git.ts';
import { isNeutralFollowUp } from './source.ts';
import type { Candidate, ReplayConfig, SkipReason, TaskSource } from './types.ts';

export const SAFETY_FACTOR = 1.5;
export const MIN_RUN_USD = 0.05;
export const DEFAULT_MAX_COMMIT_AGE_MS = 14 * 86_400_000;

export interface SelectOptions {
  tasks: readonly TaskRecord[];
  sources: ReadonlyMap<string, TaskSource>;
  labeled: ReadonlySet<string>; // taskIds that already have an L2 label (ignored with --force by the caller)
  ladder: readonly ReplayConfig[];
  includeDirty?: boolean;
  maxCommitAgeMs?: number;
  l1Cheaper?: ReadonlySet<string>; // taskIds where the L1 verdict is cheaper than what ran
  git?: GitFn;
}

export interface SelectResult {
  candidates: Candidate[]; // replayable, in priority order
  skipped: Array<{ taskId: string; reason: SkipReason }>;
  skippedByReason: Partial<Record<SkipReason, number>>;
  dirty: number; // candidates marked dirtyStart that were skipped as dirty-start are counted in skippedByReason; this is the total detected
}

// Estimated cost of one run of `cfg` for this task: its tokens priced as that tier, times the safety factor.
export function estimateRunUsd(src: Pick<TaskSource, 'repricedUsd'>, cfg: ReplayConfig): number {
  return Math.max(MIN_RUN_USD, src.repricedUsd[cfg.tier] * SAFETY_FACTOR);
}

export function selectTasks(o: SelectOptions): SelectResult {
  const git = o.git ?? runGit;
  const maxAge = o.maxCommitAgeMs ?? DEFAULT_MAX_COMMIT_AGE_MS;
  const candidates: Candidate[] = [];
  const skipped: SelectResult['skipped'] = [];
  const by: Partial<Record<SkipReason, number>> = {};
  let dirty = 0;
  const skip = (taskId: string, reason: SkipReason): void => {
    skipped.push({ taskId, reason });
    by[reason] = (by[reason] ?? 0) + 1;
  };
  const rootCache = new Map<string, string | undefined>();

  for (const t of o.tasks) {
    if (o.labeled.has(t.taskId)) {
      skip(t.taskId, 'already-labeled');
      continue;
    }
    const src = o.sources.get(t.taskId);
    if (!src) {
      skip(t.taskId, 'no-source');
      continue;
    }
    const prompts = src.prompts;
    if (prompts.length === 0 || !prompts.slice(1).every((p) => isNeutralFollowUp(p.text))) {
      skip(t.taskId, 'multi-prompt');
      continue;
    }
    if (!src.cwd) {
      skip(t.taskId, 'no-cwd');
      continue;
    }
    let root = rootCache.get(src.cwd);
    if (!rootCache.has(src.cwd)) {
      root = repoRoot(src.cwd, git);
      rootCache.set(src.cwd, root);
    }
    if (!root) {
      skip(t.taskId, existsSync(src.cwd) ? 'not-a-repo' : 'cwd-missing');
      continue;
    }
    const branch = src.gitBranch;
    if (!branch || branch === 'HEAD') {
      skip(t.taskId, 'no-branch');
      continue;
    }
    const ref = resolveBranch(root, branch, git);
    if (!ref) {
      skip(t.taskId, 'branch-missing');
      continue;
    }
    const commit = commitBefore(root, ref, src.startTs, git);
    if (!commit) {
      skip(t.taskId, 'no-commit');
      continue;
    }
    if (src.startTs - commit.ts > maxAge) {
      skip(t.taskId, 'stale-commit');
      continue;
    }
    const cwdReal = realPath(src.cwd);
    const d = detectDirtyStart(root, cwdReal, commit.sha, src, git);
    if (d.dirty) dirty += 1;
    if (d.dirty && !o.includeDirty) {
      skip(t.taskId, 'dirty-start');
      continue;
    }
    const testCommand = detectTestCommand(root, commit.sha, git);
    const originalEdited = src.edits.length > 0 || t.observed.filesEdited > 0;
    // A task that edited nothing cannot be verified: a replay that changes nothing passes any test command and any diff check.
    if (!originalEdited) {
      skip(t.taskId, 'no-verification');
      continue;
    }
    candidates.push({
      taskId: t.taskId,
      project: t.project,
      repoRoot: root,
      relCwd: relativeInside(root, cwdReal) ?? '',
      branch,
      commit: commit.sha,
      commitTs: commit.ts,
      dirtyStart: d.dirty,
      dirtyReasons: d.reasons,
      ...(testCommand ? { testCommand } : {}),
      originalEdited,
      l1Cheaper: o.l1Cheaper?.has(t.taskId) ?? false,
      estUsd: Object.fromEntries(o.ladder.map((c) => [c.id, estimateRunUsd(src, c)])),
    });
  }

  // Priority: tasks with a test command first, then (if asked) where L1 disagrees with what ran, then a stable hash order.
  candidates.sort((a, b) => {
    const k = (c: Candidate): number => (c.testCommand ? 0 : 1);
    return k(a) - k(b) || Number(b.l1Cheaper) - Number(a.l1Cheaper) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  });
  return { candidates, skipped, skippedByReason: by, dirty };
}

function relativeInside(root: string, dir: string): string | undefined {
  const r = relative(root, dir);
  return r === '' || r.startsWith('..') ? undefined : r.split('\\').join('/');
}

// With --prefer-l1-disagreement: which tasks does the judge file call cheaper than what ran.
export function l1CheaperSet(tasks: readonly TaskRecord[], l1Config: ReadonlyMap<string, string>, order: readonly string[]): Set<string> {
  const rank = (id: string): number => order.indexOf(id);
  const out = new Set<string>();
  for (const t of tasks) {
    const l1 = l1Config.get(t.taskId);
    if (!l1) continue;
    const observed = t.observed.modelTier === 'fable' ? 'opus' : t.observed.modelTier;
    const obsId = `${observed}-${t.observed.effort === 'low' || t.observed.effort === 'medium' ? t.observed.effort : 'high'}`;
    // compare by tier first: L1 below the observed tier, or the same tier at a lower effort
    const l1Tier = l1.split('-')[0]!;
    const tiers = ['haiku', 'sonnet', 'opus'];
    if (tiers.indexOf(l1Tier) < tiers.indexOf(observed) || (l1Tier === observed && rank(l1) >= 0 && rank(obsId) >= 0 && rank(l1) < rank(obsId))) out.add(t.taskId);
  }
  return out;
}
