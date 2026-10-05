// Aggregates for the terminal summary of `dataset judge`. Pure; never contains prompt text or rationales.

import { priceOf } from '../../../../plugin/core/pricing.ts';
import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';
import { OBSERVED_TIERS, L0_TIERS, type ObservedTier } from '../summary.ts';
import { isPublicTask, type JudgeTask } from '../types.ts';
import { deriveLabel } from './label.ts';
import type { RunResult } from './run.ts';
import { JUDGE_CONFIGS, type ConfigId, type JudgeBackendKind, type JudgeRecordOk } from './types.ts';

export interface JudgeSummary {
  generatedAt: string;
  backend: JudgeBackendKind;
  model: string;
  out: string;
  threshold: number;
  promptVersion: string;
  tasks: number; // tasks in tasks.jsonl
  judged: number; // tasks that have an ok verdict in the file (this run and earlier ones)
  run: RunResult & { durationMs: number };
  l1Tier: Record<TaskTier, number>;
  ladder: Record<ConfigId, number>; // distribution over the four configurations
  l0VsL1: Record<TaskTier, Record<TaskTier, number>>; // [l0][l1]
  ownJudged: number; // judged tasks from own history (they have L0 and an observed run)
  publicJudged: number; // judged public records (verified tiers, no observed run): see `dataset validate-judge`
  agreement: number; // share of own judged tasks where L0 and L1 pick the same tier
  observedVsL1: Record<ObservedTier, Record<TaskTier, number>>; // [observed][l1]
  // observed opus/fable while the judge says sonnet or haiku suffices
  overSpec: { count: number; share: number; cost: number; saving: number };
  needsPlanFirst: number;
  delegateExplore: number;
  meanDifficulty: number;
}

const zeroTiers = (): Record<TaskTier, number> => ({ haiku: 0, sonnet: 0, opus: 0 });

// Blended list price (input + output) per million tokens, for ratios only.
function blended(modelOrAlias: string | undefined): number | null {
  const p = priceOf(modelOrAlias);
  return p ? p.input + p.output : null;
}

export interface JudgeSummaryInput {
  tasks: readonly JudgeTask[];
  verdicts: ReadonlyMap<string, JudgeRecordOk>;
  backend: JudgeBackendKind;
  model: string;
  out: string;
  threshold: number;
  promptVersion: string;
  run: RunResult;
  durationMs: number;
  now?: Date;
}

export function summarizeJudge(i: JudgeSummaryInput): JudgeSummary {
  const l1Tier = zeroTiers();
  const ladder = Object.fromEntries(JUDGE_CONFIGS.map((c) => [c.id, 0])) as Record<ConfigId, number>;
  const l0VsL1 = { haiku: zeroTiers(), sonnet: zeroTiers(), opus: zeroTiers() };
  const observedVsL1 = Object.fromEntries(OBSERVED_TIERS.map((t) => [t, zeroTiers()])) as Record<ObservedTier, Record<TaskTier, number>>;
  let judged = 0;
  let own = 0;
  let publicJudged = 0;
  let agree = 0;
  let planFirst = 0;
  let explore = 0;
  let diff = 0;
  let overCount = 0;
  let overCost = 0;
  let overSaving = 0;

  for (const t of i.tasks) {
    const v = i.verdicts.get(t.taskId);
    if (!v) continue;
    judged += 1;
    // Labels are re-derived from the stored probabilities with the current threshold, so a resumed file stays consistent with --threshold.
    const label = deriveLabel(v.l1Probs, i.threshold);
    const effort: TaskEffort = label.effort;
    l1Tier[label.tier] += 1;
    ladder[`${label.tier}-${effort}` as ConfigId] += 1;
    if (v.needsPlanFirst) planFirst += 1;
    if (v.delegateExplore) explore += 1;
    diff += v.l1Difficulty;
    if (isPublicTask(t)) {
      publicJudged += 1;
      continue;
    }
    own += 1;
    l0VsL1[t.l0Tier][label.tier] += 1;
    if (t.l0Tier === label.tier) agree += 1;
    const ot = (OBSERVED_TIERS as readonly string[]).includes(t.observed.modelTier) ? (t.observed.modelTier as ObservedTier) : 'unknown';
    observedVsL1[ot][label.tier] += 1;
    if ((ot === 'opus' || ot === 'fable') && label.tier !== 'opus') {
      overCount += 1;
      overCost += t.observed.cost;
      const from = blended(t.observed.model) ?? blended(ot);
      const to = blended(label.tier);
      if (from !== null && to !== null && from > 0) overSaving += t.observed.cost * Math.max(0, 1 - to / from);
    }
  }
  const share = (x: number): number => (judged > 0 ? x / judged : 0);
  const round2 = (x: number): number => Math.round(x * 100) / 100;
  return {
    generatedAt: (i.now ?? new Date()).toISOString(),
    backend: i.backend,
    model: i.model,
    out: i.out,
    threshold: i.threshold,
    promptVersion: i.promptVersion,
    tasks: i.tasks.length,
    judged,
    run: { ...i.run, durationMs: i.durationMs },
    l1Tier,
    ladder,
    l0VsL1,
    ownJudged: own,
    publicJudged,
    agreement: own > 0 ? agree / own : 0,
    observedVsL1,
    overSpec: { count: overCount, share: own > 0 ? overCount / own : 0, cost: round2(overCost), saving: round2(overSaving) },
    needsPlanFirst: planFirst,
    delegateExplore: explore,
    meanDifficulty: judged > 0 ? diff / judged : 0,
  };
}

export { L0_TIERS, OBSERVED_TIERS };
