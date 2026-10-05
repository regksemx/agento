// Aggregates for the terminal summary of `dataset replay`. Pure; never contains prompt text.

import type { TaskTier } from '../../../../plugin/core/task.ts';
import { OBSERVED_TIERS, L0_TIERS, type ObservedTier } from '../summary.ts';
import type { TaskRecord } from '../types.ts';
import { deriveLabel } from '../judge/label.ts';
import type { JudgeRecordOk } from '../judge/types.ts';
import type { LabelRecord, RunRecord, SkipReason } from './types.ts';

export interface L1VsL2 {
  file: string;
  threshold: number;
  compared: number; // tasks with both an L1 verdict and an L2 label
  exact: number; // same tier and effort
  sameTier: number;
  l1Cheaper: number; // L1 asked for less than L2 found sufficient: the risky direction (under-routing)
  l1Dearer: number; // L1 asked for more: missed saving
  matrix: Record<TaskTier, Record<TaskTier, number>>; // [l1][l2]
}

export interface ReplaySummary {
  generatedAt: string;
  dir: string;
  tasks: number;
  selected: number;
  replayed: number; // tasks that got at least one new run in this invocation
  labeledNow: number;
  inconclusive: number;
  skipped: Partial<Record<SkipReason, number>>;
  skippedTotal: number;
  stopped?: string; // budget, daily cap, backend down
  runs: { count: number; passed: number; costUsd: number; judgeUsd: number };
  budgetUsd: number;
  labeledTotal: number; // labels in labels.jsonl for tasks of tasks.jsonl
  ladder: Record<string, number>; // L2 label distribution by configuration id
  fallback: number; // labeled opus·medium because nothing passed
  observedVsL2: Record<ObservedTier, Record<TaskTier, number>>;
  l1?: L1VsL2;
  durationMs: number;
}

const zero = (): Record<TaskTier, number> => ({ haiku: 0, sonnet: 0, opus: 0 });
const TIER_IDX: Record<TaskTier, number> = { haiku: 0, sonnet: 1, opus: 2 };
const EFFORT_IDX = { low: 0, medium: 1, high: 2 } as const;
export const configRank = (tier: TaskTier, effort: keyof typeof EFFORT_IDX): number => TIER_IDX[tier] * 3 + EFFORT_IDX[effort];

export interface ReplaySummaryInput {
  tasks: readonly TaskRecord[];
  labels: ReadonlyMap<string, LabelRecord>;
  thisRun: { selected: number; replayed: number; labeledNow: number; inconclusive: number; skipped: Partial<Record<SkipReason, number>>; stopped?: string; runs: readonly RunRecord[] };
  l1?: { file: string; threshold: number; verdicts: ReadonlyMap<string, JudgeRecordOk> };
  dir: string;
  budgetUsd: number;
  durationMs: number;
  now?: Date;
}

export function summarizeReplay(i: ReplaySummaryInput): ReplaySummary {
  const ladder: Record<string, number> = {};
  const observed = Object.fromEntries(OBSERVED_TIERS.map((t) => [t, zero()])) as Record<ObservedTier, Record<TaskTier, number>>;
  let fallback = 0;
  let labeledTotal = 0;
  const l1 = i.l1 ? { file: i.l1.file, threshold: i.l1.threshold, compared: 0, exact: 0, sameTier: 0, l1Cheaper: 0, l1Dearer: 0, matrix: { haiku: zero(), sonnet: zero(), opus: zero() } } : undefined;

  for (const t of i.tasks) {
    const l = i.labels.get(t.taskId);
    if (!l) continue;
    labeledTotal += 1;
    const id = `${l.l2Tier}-${l.l2Effort}`;
    ladder[id] = (ladder[id] ?? 0) + 1;
    if (l.l2Evidence.passedConfig === null) fallback += 1;
    const ot = (OBSERVED_TIERS as readonly string[]).includes(t.observed.modelTier) ? (t.observed.modelTier as ObservedTier) : 'unknown';
    observed[ot][l.l2Tier] += 1;
    const v = i.l1?.verdicts.get(t.taskId);
    if (l1 && v) {
      const lab = deriveLabel(v.l1Probs, l1.threshold);
      l1.compared += 1;
      l1.matrix[lab.tier][l.l2Tier] += 1;
      const a = configRank(lab.tier, lab.effort);
      const b = configRank(l.l2Tier, l.l2Effort);
      if (a === b) l1.exact += 1;
      if (lab.tier === l.l2Tier) l1.sameTier += 1;
      if (a < b) l1.l1Cheaper += 1;
      if (a > b) l1.l1Dearer += 1;
    }
  }
  const skippedTotal = Object.values(i.thisRun.skipped).reduce((a, b) => a + (b ?? 0), 0);
  const runs = i.thisRun.runs;
  return {
    generatedAt: (i.now ?? new Date()).toISOString(),
    dir: i.dir,
    tasks: i.tasks.length,
    selected: i.thisRun.selected,
    replayed: i.thisRun.replayed,
    labeledNow: i.thisRun.labeledNow,
    inconclusive: i.thisRun.inconclusive,
    skipped: i.thisRun.skipped,
    skippedTotal,
    ...(i.thisRun.stopped ? { stopped: i.thisRun.stopped } : {}),
    runs: {
      count: runs.length,
      passed: runs.filter((r) => r.pass).length,
      costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
      judgeUsd: runs.reduce((a, r) => a + (r.judgeCostUsd ?? 0), 0),
    },
    budgetUsd: i.budgetUsd,
    labeledTotal,
    ladder,
    fallback,
    observedVsL2: observed,
    ...(l1 ? { l1 } : {}),
    durationMs: i.durationMs,
  };
}

export { L0_TIERS, OBSERVED_TIERS };
