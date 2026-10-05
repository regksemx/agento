// Aggregates over the written records: what the terminal summary and `summary.json` report. Never contains prompt text.

import type { TaskTier } from '../../../plugin/core/task.ts';
import { addHits, emptyHits, type ScrubHits } from './scrub.ts';
import type { TaskRecord } from './types.ts';

export const L0_TIERS: readonly TaskTier[] = ['haiku', 'sonnet', 'opus'];
export const OBSERVED_TIERS = ['haiku', 'sonnet', 'opus', 'fable', 'unknown'] as const;
export type ObservedTier = (typeof OBSERVED_TIERS)[number];

export interface DatasetSummary {
  version: 1;
  generatedAt: string;
  out: string;
  tasks: number;
  sessions: number;
  projects: number;
  filters: { since: string; project?: string };
  l0Tier: Record<TaskTier, number>;
  l0Effort: Record<'low' | 'medium' | 'high', number>;
  observedTier: Record<ObservedTier, number>;
  // confusion[observed tier][l0 tier]
  confusion: Record<ObservedTier, Record<TaskTier, number>>;
  // observed opus/fable while L0 says sonnet or haiku: the share of history that looks like over-spend
  overSpec: { count: number; share: number; cost: number };
  withCorrections: { count: number; share: number };
  rulesAgreement: number; // share of tasks where classifyRules and L0 pick the same tier
  totalCost: number;
  scrub: { hits: ScrubHits; total: number };
  durationMs: number;
}

const zeroTiers = (): Record<TaskTier, number> => ({ haiku: 0, sonnet: 0, opus: 0 });

export interface SummaryInput {
  records: TaskRecord[];
  hits: ScrubHits;
  out: string;
  sessions: number;
  since: string;
  project?: string;
  durationMs: number;
  now?: Date;
}

export function summarize(i: SummaryInput): DatasetSummary {
  const n = i.records.length;
  const l0Tier = zeroTiers();
  const l0Effort = { low: 0, medium: 0, high: 0 };
  const observedTier = Object.fromEntries(OBSERVED_TIERS.map((t) => [t, 0])) as Record<ObservedTier, number>;
  const confusion = Object.fromEntries(OBSERVED_TIERS.map((t) => [t, zeroTiers()])) as Record<ObservedTier, Record<TaskTier, number>>;
  let corrected = 0;
  let agree = 0;
  let overCount = 0;
  let overCost = 0;
  let totalCost = 0;
  const projects = new Set<string>();

  for (const r of i.records) {
    projects.add(r.project);
    l0Tier[r.l0Tier] += 1;
    l0Effort[r.l0Effort] += 1;
    const ot = (OBSERVED_TIERS as readonly string[]).includes(r.observed.modelTier) ? (r.observed.modelTier as ObservedTier) : 'unknown';
    observedTier[ot] += 1;
    confusion[ot][r.l0Tier] += 1;
    if (r.observed.userCorrections > 0) corrected += 1;
    if (r.rulesVerdict.tier === r.l0Tier) agree += 1;
    totalCost += r.observed.cost;
    if ((ot === 'opus' || ot === 'fable') && r.l0Tier !== 'opus') {
      overCount += 1;
      overCost += r.observed.cost;
    }
  }
  const hits = emptyHits();
  addHits(hits, i.hits);
  const share = (x: number): number => (n > 0 ? x / n : 0);
  return {
    version: 1,
    generatedAt: (i.now ?? new Date()).toISOString(),
    out: i.out,
    tasks: n,
    sessions: i.sessions,
    projects: projects.size,
    filters: { since: i.since, ...(i.project ? { project: i.project } : {}) },
    l0Tier,
    l0Effort,
    observedTier,
    confusion,
    overSpec: { count: overCount, share: share(overCount), cost: Math.round(overCost * 100) / 100 },
    withCorrections: { count: corrected, share: share(corrected) },
    rulesAgreement: share(agree),
    totalCost: Math.round(totalCost * 100) / 100,
    scrub: { hits, total: Object.values(hits).reduce((a, b) => a + b, 0) },
    durationMs: i.durationMs,
  };
}
