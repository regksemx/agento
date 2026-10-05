// Validation of the L1 judge against verified public tiers (TwinRouterBench): agreement, under-/over-routing, calibration of
// "sonnet suffices", and the threshold sweep that decides the judge threshold. Pure: records in, numbers out.

import { priceOf } from '../../../../plugin/core/pricing.ts';
import type { TaskTier } from '../../../../plugin/core/task.ts';
import { deriveLabel } from '../judge/label.ts';
import type { JudgeProbs, JudgeRecordOk } from '../judge/types.ts';
import type { PublicTaskRecord } from '../types.ts';

export const TIERS: readonly TaskTier[] = ['haiku', 'sonnet', 'opus'];
export const SWEEP_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const BIN_COUNT = 10;
export const DEFAULT_MAX_UNDER = 0.05;

const rank = (t: TaskTier): number => TIERS.indexOf(t);

export interface Agreement {
  n: number;
  exact: number;
  under: number; // judge cheaper than verified: the quality risk
  over: number; // judge dearer than verified: a missed saving
  accuracy: number;
  underRate: number;
  overRate: number;
}

export interface SweepRow extends Agreement {
  threshold: number;
  saving: number; // 1 - cost(routed) / cost(all opus), list prices
  recommended?: boolean;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  observed: number; // share of the bin whose verified tier really was sufficient
}

export interface Reliability {
  bins: ReliabilityBin[];
  ece: number; // expected calibration error: sum over bins of n/N * |observed - meanP|
  brier: number;
  base: number; // overall share of "sufficient"
}

export interface ValidationSummary {
  version: 1;
  generatedAt: string;
  judgeFile: string;
  labelsFile: string;
  threshold: number;
  promptVersions: string[];
  judgeModels: string[];
  labelled: number; // public records in the labels file (after the --benchmark filter)
  compared: number; // records with a verdict
  notJudged: number;
  unmatchedVerdicts: number; // verdicts whose taskId is not in the labels file
  benchmarks: string[];
  verified: Record<TaskTier, number>; // distribution of the verified tiers among compared
  predicted: Record<TaskTier, number>;
  majorityBaseline: number; // accuracy of always predicting the commonest verified tier
  main: Agreement;
  confusion: Record<TaskTier, Record<TaskTier, number>>; // [verified][predicted]
  byBenchmark: Array<{ benchmark: string } & Agreement>;
  sonnetSuffices: Reliability; // p(sonnet-medium or sonnet-high) against verified tier != opus
  haikuSuffices: Reliability; // p(haiku-low) against verified tier == haiku
  sweep: SweepRow[];
  oracleSaving: number; // saving of routing every step to its verified tier
  maxUnder: number;
  recommended?: number; // threshold with the largest saving among those with underRate <= maxUnder
}

const zeroTiers = (): Record<TaskTier, number> => ({ haiku: 0, sonnet: 0, opus: 0 });

// Blended list price (input + output) per million tokens: a ratio, not a bill.
function price(t: TaskTier): number {
  const p = priceOf(t);
  return p ? p.input + p.output : { haiku: 1, sonnet: 3, opus: 5 }[t];
}

export function agreement(pairs: ReadonlyArray<{ truth: TaskTier; pred: TaskTier }>): Agreement {
  const n = pairs.length;
  let exact = 0;
  let under = 0;
  let over = 0;
  for (const p of pairs) {
    const d = rank(p.pred) - rank(p.truth);
    if (d === 0) exact += 1;
    else if (d < 0) under += 1;
    else over += 1;
  }
  const r = (x: number): number => (n > 0 ? x / n : 0);
  return { n, exact, under, over, accuracy: r(exact), underRate: r(under), overRate: r(over) };
}

export const pSonnet = (p: JudgeProbs): number => Math.max(p['sonnet-medium'], p['sonnet-high']);

export function reliability(points: ReadonlyArray<{ p: number; y: boolean }>): Reliability {
  const bins: ReliabilityBin[] = Array.from({ length: BIN_COUNT }, (_, i) => ({ lo: i / BIN_COUNT, hi: (i + 1) / BIN_COUNT, n: 0, meanP: 0, observed: 0 }));
  let brier = 0;
  let pos = 0;
  for (const pt of points) {
    const b = bins[Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(pt.p * BIN_COUNT)))]!;
    b.n += 1;
    b.meanP += pt.p;
    b.observed += pt.y ? 1 : 0;
    brier += (pt.p - (pt.y ? 1 : 0)) ** 2;
    if (pt.y) pos += 1;
  }
  const N = points.length;
  let ece = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    b.meanP /= b.n;
    b.observed /= b.n;
    ece += (b.n / N) * Math.abs(b.observed - b.meanP);
  }
  return { bins, ece: N > 0 ? ece : 0, brier: N > 0 ? brier / N : 0, base: N > 0 ? pos / N : 0 };
}

export interface ValidateInput {
  labels: readonly PublicTaskRecord[];
  verdicts: ReadonlyMap<string, JudgeRecordOk>;
  judgeFile: string;
  labelsFile: string;
  threshold: number;
  benchmarks?: readonly string[]; // only these workloads
  maxUnder?: number;
  now?: Date;
}

export function validateJudge(i: ValidateInput): ValidationSummary {
  const filter = i.benchmarks && i.benchmarks.length > 0 ? new Set(i.benchmarks) : undefined;
  const labels = i.labels.filter((l) => !filter || filter.has(l.l2Evidence.benchmark));
  const labelIds = new Set(i.labels.map((l) => l.taskId));
  const joined = labels.flatMap((l) => {
    const v = i.verdicts.get(l.taskId);
    return v ? [{ l, v }] : [];
  });

  const at = (thr: number) => joined.map(({ l, v }) => ({ truth: l.l2Tier, pred: deriveLabel(v.l1Probs, thr).tier, bench: l.l2Evidence.benchmark }));
  const main = at(i.threshold);
  const verified = zeroTiers();
  const predicted = zeroTiers();
  const confusion = { haiku: zeroTiers(), sonnet: zeroTiers(), opus: zeroTiers() };
  for (const p of main) {
    verified[p.truth] += 1;
    predicted[p.pred] += 1;
    confusion[p.truth][p.pred] += 1;
  }
  const n = main.length;
  const majority = n > 0 ? Math.max(...TIERS.map((t) => verified[t])) / n : 0;

  const benchNames = [...new Set(main.map((p) => p.bench))].sort();
  const byBenchmark = benchNames.map((b) => ({ benchmark: b, ...agreement(main.filter((p) => p.bench === b)) }));

  const costOpus = joined.length * price('opus');
  const saving = (pairs: ReadonlyArray<{ pred: TaskTier }>): number => (costOpus > 0 ? 1 - pairs.reduce((a, p) => a + price(p.pred), 0) / costOpus : 0);
  const maxUnder = i.maxUnder ?? DEFAULT_MAX_UNDER;
  const sweep: SweepRow[] = SWEEP_THRESHOLDS.map((thr) => {
    const pairs = at(thr);
    return { threshold: thr, ...agreement(pairs), saving: saving(pairs) };
  });
  let best: SweepRow | undefined;
  // ties go to the higher (safer) threshold
  for (const r of sweep) if (r.n > 0 && r.underRate <= maxUnder && (!best || r.saving >= best.saving - 1e-9)) best = r;
  if (best) best.recommended = true;

  return {
    version: 1,
    generatedAt: (i.now ?? new Date()).toISOString(),
    judgeFile: i.judgeFile,
    labelsFile: i.labelsFile,
    threshold: i.threshold,
    promptVersions: [...new Set(joined.map(({ v }) => v.promptVersion))].sort(),
    judgeModels: [...new Set(joined.map(({ v }) => v.judgeModelResolved ?? v.judgeModel))].sort(),
    labelled: labels.length,
    compared: n,
    notJudged: labels.length - n,
    unmatchedVerdicts: [...i.verdicts.keys()].filter((id) => !labelIds.has(id)).length,
    benchmarks: [...new Set(labels.map((l) => l.l2Evidence.benchmark))].sort(),
    verified,
    predicted,
    majorityBaseline: majority,
    main: agreement(main),
    confusion,
    byBenchmark,
    sonnetSuffices: reliability(joined.map(({ l, v }) => ({ p: pSonnet(v.l1Probs), y: l.l2Tier !== 'opus' }))),
    haikuSuffices: reliability(joined.map(({ l, v }) => ({ p: v.l1Probs['haiku-low'], y: l.l2Tier === 'haiku' }))),
    sweep,
    oracleSaving: saving(joined.map(({ l }) => ({ pred: l.l2Tier }))),
    maxUnder,
    ...(best ? { recommended: best.threshold } : {}),
  };
}
