// Agreement of the automatic guesses (L0, rules, the L1 judge) and of the history with the human labels.
// This is the judge's validation on the owner's own tasks. Pure; never contains prompt text.

import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';
import type { TaskRecord } from '../types.ts';
import { EFFORTS, TIERS, tierRank, type HumanRecord, type L1Guess } from './types.ts';

export type SourceId = 'l0' | 'rules' | 'l1' | 'history';
export const SOURCE_IDS: readonly SourceId[] = ['l0', 'rules', 'l1', 'history'];

export interface SourceAgreement {
  id: SourceId;
  n: number; // labeled tasks this source has a guess for
  tierHit: number;
  under: number; // guess cheaper than the human tier: would have broken the task
  over: number; // guess more expensive than the human tier: wasted money
  effortN: number;
  effortHit: number;
  confusion: Record<TaskTier, Record<TaskTier, number>>; // [human][guess]
}

export interface HumanReport {
  tasksTotal: number; // in tasks.jsonl
  labeled: number; // with a full verdict
  unsure: number; // answered "don't remember"
  tier: Record<TaskTier, number>;
  effort: Record<TaskEffort, number>;
  planYes: number;
  delegateYes: number;
  meanSeconds: number;
  sources: SourceAgreement[];
  l1Flags: { planN: number; planHit: number; delegateN: number; delegateHit: number };
}

const zero3 = (): Record<TaskTier, number> => ({ haiku: 0, sonnet: 0, opus: 0 });
const zeroConf = (): Record<TaskTier, Record<TaskTier, number>> => ({ haiku: zero3(), sonnet: zero3(), opus: zero3() });

export function observedEffort(e: string | undefined): TaskEffort | undefined {
  if (e === 'low' || e === 'medium' || e === 'high') return e;
  if (e === 'xhigh' || e === 'max') return 'high';
  return undefined;
}

export function observedTier(t: string): TaskTier | undefined {
  if (t === 'haiku' || t === 'sonnet' || t === 'opus') return t;
  if (t === 'fable') return 'opus';
  return undefined;
}

export function computeReport(tasks: readonly TaskRecord[], human: ReadonlyMap<string, HumanRecord>, l1: ReadonlyMap<string, L1Guess>): HumanReport {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const tier = zero3();
  const effort = { low: 0, medium: 0, high: 0 };
  const src = new Map<SourceId, SourceAgreement>(SOURCE_IDS.map((id) => [id, { id, n: 0, tierHit: 0, under: 0, over: 0, effortN: 0, effortHit: 0, confusion: zeroConf() }]));
  const flags = { planN: 0, planHit: 0, delegateN: 0, delegateHit: 0 };
  let labeled = 0;
  let unsure = 0;
  let planYes = 0;
  let delegateYes = 0;
  let seconds = 0;
  let counted = 0;

  for (const h of human.values()) {
    const t = byId.get(h.taskId);
    if (!t) continue; // a label of a task that is no longer in tasks.jsonl
    if (h.l2Tier === null || !TIERS.includes(h.l2Tier)) {
      unsure += 1;
      continue;
    }
    labeled += 1;
    tier[h.l2Tier] += 1;
    if (h.l2Effort && EFFORTS.includes(h.l2Effort)) effort[h.l2Effort] += 1;
    if (h.l2PlanFirst) planYes += 1;
    if (h.l2DelegateExplore) delegateYes += 1;
    seconds += h.labelerSeconds;
    counted += 1;

    const guesses: Array<[SourceId, TaskTier | undefined, TaskEffort | undefined]> = [
      ['l0', t.l0Tier, t.l0Effort],
      ['rules', t.rulesVerdict.tier, t.rulesVerdict.effort],
      ['l1', l1.get(t.taskId)?.tier, l1.get(t.taskId)?.effort],
      ['history', observedTier(t.observed.modelTier), observedEffort(t.observed.effort)],
    ];
    for (const [id, gt, ge] of guesses) {
      if (!gt) continue;
      const s = src.get(id)!;
      s.n += 1;
      s.confusion[h.l2Tier][gt] += 1;
      if (gt === h.l2Tier) s.tierHit += 1;
      else if (tierRank(gt) < tierRank(h.l2Tier)) s.under += 1;
      else s.over += 1;
      if (ge && h.l2Effort) {
        s.effortN += 1;
        if (ge === h.l2Effort) s.effortHit += 1;
      }
    }
    const g = l1.get(t.taskId);
    if (g?.planFirst !== undefined && h.l2PlanFirst !== null) {
      flags.planN += 1;
      if (g.planFirst === h.l2PlanFirst) flags.planHit += 1;
    }
    if (g?.delegateExplore !== undefined && h.l2DelegateExplore !== null) {
      flags.delegateN += 1;
      if (g.delegateExplore === h.l2DelegateExplore) flags.delegateHit += 1;
    }
  }
  return { tasksTotal: tasks.length, labeled, unsure, tier, effort, planYes, delegateYes, meanSeconds: counted > 0 ? seconds / counted : 0, sources: [...src.values()], l1Flags: flags };
}
