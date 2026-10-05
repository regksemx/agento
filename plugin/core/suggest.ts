// What to suggest at a prompt: task-start detection (spec §4.4), the downgrade a verdict calls for, and which
// banner (or autopilot action) follows. Pure TypeScript: the mod only feeds it facts and shows the answer.
// Principles it keeps: P1 (a model is only ever changed at a clean point), P3 (only downward, never above the
// user's choice).

import { COLD_MARGIN_MS, isWarm, TTL_MS, type LineageState } from './cache.ts';
import { modelIdForTier, tierOf, tierRank, TIER_ALIAS, type Tier } from './pricing.ts';
import type { Mode } from './spawn-policy.ts';
import { startKindOf } from './brain.ts';
import { classifyRules, extractFeatures, isTaskStart, topicShift, type TaskContext, type TaskEffort, type TaskFeatures, type TaskStartReason, type TaskVerdict } from './task.ts';

export type Scenario = 'S1' | 'S2a' | 'S2b' | 'S4' | 'S7' | 'AP';

// One banner at a time; a higher number takes the band from a lower one. S7 > S2 > (autopilot notice) > S1 > S4.
export const PRIORITY: Record<Scenario, number> = { S7: 6, S2a: 5, S2b: 5, AP: 4, S1: 3, S4: 2 };

export function canReplace(shown: Scenario | undefined, next: Scenario): boolean {
  return shown === undefined || PRIORITY[next] >= PRIORITY[shown];
}

// "Don't suggest" is kept per scenario and directory; the two handoff banners are one scenario to the user.
export type DismissKey = 'S1' | 'S2' | 'S4';

export function dismissKeyOf(s: Scenario): DismissKey | null {
  if (s === 'S1') return 'S1';
  if (s === 'S2a' || s === 'S2b') return 'S2';
  if (s === 'S4') return 'S4';
  return null;
}

export const dismissStoreKey = (k: DismissKey, cwd: string): string => `dismiss:${k}:${cwd}`;

export const CONFIDENCE_BALANCED = 0.65;
export const CONFIDENCE_ECO = 0.55;
// "Discuss the architecture with Opus" is only a conversation starter: the heavy/plan rules' own 0.6 is enough.
export const CONFIDENCE_HANDOFF = 0.55;

// The context size where an old, warm conversation starts to cost real money on every step (spec S4).
export const S4_CONTEXT_TOKENS = 60_000;
export const S4_BIG_CONTEXT_TOKENS = 150_000;
export const S4_TOPIC_SHIFT = 0.85;

// S1 and autopilot never run in `quality`; nothing runs in `off`.
export function confidenceThreshold(mode: Mode): number {
  return mode === 'eco' ? CONFIDENCE_ECO : mode === 'balanced' ? CONFIDENCE_BALANCED : Number.POSITIVE_INFINITY;
}

// ───────────────────────── what the verdict calls for ─────────────────────────

export const EFFORT_ORDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function effortRank(e: string | null | undefined): number {
  return e ? EFFORT_ORDER.indexOf(e) : -1;
}

export interface Current {
  model: string;
  effort: string | null;
}

export interface Downgrade {
  // A tier alias to switch to (`sonnet`), when the current model is pricier than the verdict's tier.
  model?: string;
  // An effort level, when the current effort is higher than the verdict's.
  effort?: TaskEffort;
}

// Only ever downward: a model of a lower tier, an effort lower than the current one. Null when the user's
// setup already is at or below the verdict (P3: agento never raises anything).
export function downgradeFor(cur: Current, verdict: Pick<TaskVerdict, 'tier' | 'effort'>): Downgrade | null {
  const out: Downgrade = {};
  const curTier = tierOf(cur.model);
  if (curTier !== null && tierRank(curTier) > tierRank(verdict.tier)) out.model = TIER_ALIAS[verdict.tier];
  const cr = effortRank(cur.effort);
  if (cr >= 0 && cr > effortRank(verdict.effort)) out.effort = verdict.effort;
  return out.model || out.effort ? out : null;
}

// ───────────────────────── task start (spec §4.4) ─────────────────────────

export interface TaskStartFacts {
  isFirstPrompt: boolean;
  marker: 'clear' | 'compact' | null;
  explicitNew: boolean;
  mainCache: LineageState | undefined;
  now: number;
}

export interface StartInfo {
  reason: TaskStartReason;
  // True when a model switch costs nothing extra: the cache is empty or cold, or the conversation is rewritten anyway.
  freeSwitch: boolean;
  // Tokens the conversation carries into this task (0 for a fresh one).
  contextTokens: number;
}

export function detectTaskStart(f: TaskStartFacts): StartInfo | null {
  const reason = isTaskStart({
    isFirstPrompt: f.isFirstPrompt,
    markerSinceLastPrompt: f.marker,
    msSinceLastMainCall: f.mainCache ? f.now - f.mainCache.lastAt : null,
    // The cache counts as cold a little before its TTL runs out (spec §4.3).
    ttlMs: f.mainCache ? TTL_MS[f.mainCache.ttl] - COLD_MARGIN_MS : TTL_MS['5m'] - COLD_MARGIN_MS,
    explicitNew: f.explicitNew,
  });
  if (!reason) return null;
  const cold = !f.mainCache || !isWarm(f.mainCache, f.now);
  // /clear and a compaction start the conversation over; at a first prompt there is nothing yet; after idle the
  // cache is gone. Only an explicit `/agento new` on a warm cache is not free.
  const freeSwitch = reason !== 'explicit' || cold;
  const fresh = reason === 'first-prompt' || reason === 'clear' || reason === 'compact';
  return { reason, freeSwitch, contextTokens: fresh ? 0 : (f.mainCache?.prefixTokens ?? 0) };
}

// ───────────────────────── the decision ─────────────────────────

export interface PromptFacts extends TaskStartFacts {
  mode: Mode;
  autopilot: 'off' | 'clean-points';
  suggestions: boolean;
  prompt: string;
  prevPrompt: string;
  current: Current;
  // The main conversation's size now (before this prompt).
  contextTokens: number;
  // A trained classifier's verdict for this prompt, asked for only where this prompt starts a task (a clean point);
  // it goes through every guard below exactly as the rules' does. Absent: the local rules decide.
  verdict?: TaskVerdict;
  dismissed: readonly DismissKey[];
  // Scenarios already shown for the task in progress.
  shown: readonly string[];
}

export type S4Reason = 'topic-shift' | 'big-context' | 'new-task';

export type PromptAction =
  | { kind: 'none' }
  | { kind: 'autopilot'; down: Downgrade }
  | { kind: 'S1'; down: Downgrade }
  | { kind: 'S2a' }
  | { kind: 'S4'; why: S4Reason; shift: number };

export interface PromptDecision {
  start: StartInfo | null;
  features: TaskFeatures | null;
  verdict: TaskVerdict | null;
  action: PromptAction;
}

// What a classifier is told of a task that starts here.
export function taskContextOf(start: StartInfo, contextTokens: number): TaskContext {
  return { contextTokens, isSessionStart: start.reason === 'first-prompt', startKind: startKindOf(start.reason) };
}

export function decidePrompt(f: PromptFacts): PromptDecision {
  const none: PromptDecision = { start: null, features: null, verdict: null, action: { kind: 'none' } };
  if (f.mode === 'off') return none;
  const start = detectTaskStart(f);
  const ctx = start ? start.contextTokens : f.contextTokens;
  const is = (d: DismissKey): boolean => f.dismissed.includes(d);
  const wasShown = (s: string): boolean => f.shown.includes(s);
  const canS4 = f.suggestions && !is('S4') && !wasShown('S4');

  if (!start) {
    // A new topic in a warm, long context is not a clean point: no model suggestion, a /clear one instead.
    if (!canS4) return none;
    const shift = topicShift(f.prevPrompt, f.prompt);
    if (ctx > S4_CONTEXT_TOKENS && shift >= S4_TOPIC_SHIFT) return { ...none, action: { kind: 'S4', why: 'topic-shift', shift } };
    if (ctx > S4_BIG_CONTEXT_TOKENS) return { ...none, action: { kind: 'S4', why: 'big-context', shift } };
    return none;
  }

  const features = extractFeatures(f.prompt, taskContextOf(start, ctx));
  const verdict = f.verdict ?? classifyRules(features);
  const base: PromptDecision = { start, features, verdict, action: { kind: 'none' } };

  // `/agento new` on a warm, long conversation: the switch is not free, the clean start is /clear.
  if (!start.freeSwitch && ctx > S4_CONTEXT_TOKENS && canS4) return { ...base, action: { kind: 'S4', why: 'new-task', shift: 1 } };

  if (f.mode === 'quality') return base;

  // Heavy or planning work on a cheaper model: offer the architect → executor handoff (S2).
  const curTier = tierOf(f.current.model);
  const planning = verdict.tier === 'opus' || features.keywords.plan >= 1 || verdict.planFirst === true;
  if (f.suggestions && !is('S2') && planning && verdict.confidence >= CONFIDENCE_HANDOFF && curTier !== null && tierRank(curTier) < tierRank('opus')) {
    return { ...base, action: { kind: 'S2a' } };
  }

  const down = verdict.confidence >= confidenceThreshold(f.mode) ? downgradeFor(f.current, verdict) : null;
  if (down) {
    if (f.autopilot === 'clean-points' && start.freeSwitch) return { ...base, action: { kind: 'autopilot', down } };
    if (f.suggestions && !is('S1') && !wasShown('S1')) return { ...base, action: { kind: 'S1', down } };
  }
  if (canS4 && ctx > S4_BIG_CONTEXT_TOKENS) return { ...base, action: { kind: 'S4', why: 'big-context', shift: 0 } };
  return base;
}

// ───────────────────────── autopilot: the clean-point turn ─────────────────────────

// `$.command.run` is refused inside `prompt.submit` (it would wait on the very turn that hook holds), and `/model` and
// `/effort` in an interactive session are saved as the user's default for every new session — not agento's to change.
// So the decision is kept for the task alone and the task's main requests are sent on the cheaper setup, from its
// first request to its last; the next clean point decides again. The session's own model is never touched.
export interface Override {
  // A tier alias (`sonnet`) and the exact id to name in a request; absent when only effort comes down.
  model?: string;
  modelId?: string;
  effort?: string;
  // What the user had, for the undo.
  fromModel: string;
  fromEffort: string | null;
  // Legacy (older versions ran `/model` and set this): a persisted override rewrites nothing.
  persisted: boolean;
  since: number;
}

// The override for a decided downgrade, or null when the id of the target cannot be named safely.
export function makeOverride(down: Downgrade, current: Current, now: number): Override | null {
  let modelId: string | null = null;
  if (down.model) {
    modelId = modelIdForTier(down.model as Tier, current.model);
    if (!modelId) return null;
  }
  return {
    ...(down.model && modelId ? { model: down.model, modelId } : {}),
    ...(down.effort ? { effort: down.effort } : {}),
    fromModel: current.model,
    fromEffort: current.effort,
    persisted: false,
    since: now,
  };
}

export interface StepRewrite {
  model?: string;
  effort?: TaskEffort;
}

// What to change in a main request of the task, only ever downward (P3): a model only if the request names a pricier
// tier than the override's, an effort only if it asks for more than the override's. A request on another tier than
// the one the user had (they picked another model, the engine fell back) is theirs and left alone; the target id is
// named only when the request's own id is a plain first-party one (never a gateway's, a cloud's or a `[1m]` one).
export function overrideFor(o: Pick<Override, 'model' | 'modelId' | 'effort' | 'persisted'> & { fromModel?: string }, step: { model: string; effort?: string | number }): StepRewrite | null {
  if (o.persisted) return null;
  const out: StepRewrite = {};
  const tier = tierOf(step.model);
  if (o.fromModel !== undefined && tier !== tierOf(o.fromModel)) return null;
  const id = o.model ? modelIdForTier(o.model as Tier, step.model) : null;
  if (o.model && id && tier !== null && tierRank(tier) > tierRank(o.model as Tier)) out.model = id;
  if (o.effort && typeof step.effort === 'string' && effortRank(step.effort) > effortRank(o.effort)) out.effort = o.effort as TaskEffort;
  return out.model || out.effort ? out : null;
}
