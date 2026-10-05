// What a suggestion is worth: dollars (or weekly-limit percent) per task. Pure TypeScript.
// Every figure here is an estimate and is shown as one (P6).

import { repriceAs, type Usage } from './cost.ts';
import { tierOf, type Tier } from './pricing.ts';
import type { TaskVerdict } from './task.ts';

// The reference step: 100k read from the cache, 3k written, 1.5k out.
export const REFERENCE_STEP: Usage = {
  input_tokens: 0,
  output_tokens: 1500,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 3000,
};

// Requests a task of each class takes when there is no history to say (audit §6.3: "light" is ≤ 8).
export const DEFAULT_TASK_STEPS: Record<TaskClass, number> = { light: 8, default: 15, heavy: 25 };

// A class needs this many finished tasks on a tier before its average is trusted.
export const MIN_CLASS_TASKS = 3;

export type TaskClass = 'light' | 'default' | 'heavy';

export function classOf(v: Pick<TaskVerdict, 'tier' | 'effort'>): TaskClass {
  if (v.tier === 'opus') return 'heavy';
  if (v.effort === 'low' || v.effort === 'medium') return 'light';
  return 'default';
}

// What one step saves by running on `to` instead of `from`, on the reference step (spec §1: ≈ $0.0225 for opus → sonnet).
export function stepSaving(from: string, to: string): number | null {
  const a = repriceAs(from, REFERENCE_STEP)?.total;
  const b = repriceAs(to, REFERENCE_STEP)?.total;
  if (a === undefined || b === undefined) return null;
  return a - b;
}

// ---- per-class task averages, kept in $.store as `cls:<class>` ----

export interface TierStats {
  tasks: number;
  cost: number;
  steps: number;
}

export interface ClassStats {
  byTier: Partial<Record<Tier, TierStats>>;
}

export const classKey = (c: TaskClass): string => `cls:${c}`;

export function isClassStats(v: unknown): v is ClassStats {
  return !!v && typeof v === 'object' && !!(v as ClassStats).byTier && typeof (v as ClassStats).byTier === 'object';
}

// Folds one finished task (its cost on the tier it ran on) into the class's stats.
export function foldClassStats(prev: unknown, tier: Tier, cost: number, steps: number): ClassStats {
  const base: ClassStats = isClassStats(prev) ? prev : { byTier: {} };
  const t = base.byTier[tier] ?? { tasks: 0, cost: 0, steps: 0 };
  return { byTier: { ...base.byTier, [tier]: { tasks: t.tasks + 1, cost: t.cost + cost, steps: t.steps + steps } } };
}

export function averageCost(stats: ClassStats | undefined, tier: Tier | null): number | null {
  if (!stats || !tier) return null;
  const t = stats.byTier[tier];
  return t && t.tasks >= MIN_CLASS_TASKS ? t.cost / t.tasks : null;
}

export type EstimateBasis = 'history' | 'ratio' | 'default';

export interface Saving {
  usd: number;
  basis: EstimateBasis;
}

// What moving a task of this class from `fromModel` to `toModel` is worth, in dollars per task:
//  history: both tiers have enough finished tasks — the difference of their averages;
//  ratio:   only the current tier has — its average scaled by the reference step's price ratio;
//  default: nothing recorded yet — the class's typical step count times the reference step saving (spec §1).
// Null when a price is unknown, or the move saves nothing.
export function estimateSaving(cls: TaskClass, fromModel: string, toModel: string, stats: ClassStats | undefined): Saving | null {
  const fromTier = tierOf(fromModel);
  const toTier = tierOf(toModel);
  const perStep = stepSaving(fromModel, toModel);
  if (perStep === null || perStep <= 0) return null;
  const avgFrom = averageCost(stats, fromTier);
  const avgTo = averageCost(stats, toTier);
  if (avgFrom !== null && avgTo !== null && avgFrom > avgTo) return { usd: avgFrom - avgTo, basis: 'history' };
  if (avgFrom !== null) {
    const from = repriceAs(fromModel, REFERENCE_STEP)?.total ?? 0;
    return from > 0 ? { usd: avgFrom * (perStep / from), basis: 'ratio' } : null;
  }
  return { usd: DEFAULT_TASK_STEPS[cls] * perStep, basis: 'default' };
}

// What a prefix of `tokens` costs to read on every step on `model` (spec S4: 120k ≈ $0.024 per step on opus 5.5).
export function readCostPerStep(model: string, tokens: number): number | null {
  const r = repriceAs(model, { ...REFERENCE_STEP, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens });
  return r ? r.total : null;
}

// The executor of a handoff starts from the plan alone (spec §7.4: about 5–10k tokens).
export const EXECUTOR_CONTEXT_TOKENS = 8000;

// What writing the code on `toModel` from a clean context is worth, against carrying the planning conversation
// (`plannerTokens`, read at the planner's price on every step) on `fromModel`: per-step price difference plus the
// smaller read, less the one-time write of the executor's small prefix. `steps` is the task's expected length.
export function handoffSaving(fromModel: string, toModel: string, plannerTokens: number, steps: number): number | null {
  const price = stepSaving(fromModel, toModel);
  const readFrom = readCostPerStep(fromModel, plannerTokens);
  const readTo = readCostPerStep(toModel, EXECUTOR_CONTEXT_TOKENS);
  const write = repriceAs(toModel, { ...REFERENCE_STEP, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: EXECUTOR_CONTEXT_TOKENS });
  if (price === null || readFrom === null || readTo === null || !write) return null;
  const usd = steps * (price + (readFrom - readTo)) - write.total;
  return usd > 0 ? usd : null;
}
