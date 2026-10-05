import type {
  AgentoCredit,
  AgentoHandoffRecord,
  AgentoHintCounts,
  AgentoLedger,
  AgentoLoopSignalRecord,
  AgentoMechanism,
  AgentoSpawnDecision,
  AgentoStep,
  AgentoTokens,
} from '../types';
import { costOf, normalizeUsage, repriceAs } from '../core/cost.ts';
import { nextLineageState, type Ttl } from '../core/cache.ts';
import { tierOf } from '../core/pricing.ts';
import type { Mode } from '../core/spawn-policy.ts';

export const KEEP_DAYS = 90;
const MAX_RECENT = 100;
const MAX_DECISIONS = 50;
const MAX_SIGNALS = 20;
// Subagents come and go: a long session spawns hundreds. Their cache lines and routing decisions are kept for the most
// recent ones only, so the session state (copied on every step) stays small. The main line is always kept.
export const MAX_AGENT_LINEAGES = 50;
export const MAX_ROUTED = 100;

// The record with `key` set last; past `max` entries (`keep`'s aside) the oldest go (an object keeps insertion order).
function setCapped<T>(rec: Record<string, T>, key: string, value: T, max: number, keep?: (k: string) => boolean): Record<string, T> {
  const { [key]: _old, ...rest } = rec;
  const keys = Object.keys(rest);
  const droppable = keys.filter((k) => !keep?.(k));
  const drop = new Set(droppable.slice(0, Math.max(0, droppable.length + (keep?.(key) ? 0 : 1) - max)));
  const out: Record<string, T> = {};
  for (const k of keys) if (!drop.has(k)) out[k] = rest[k] as T;
  out[key] = value;
  return out;
}

export function lineageOf(agentId: string | undefined): string {
  return agentId ? `agent:${agentId}` : 'main';
}

const zeroTokens = (): AgentoTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function emptyLedger(now: number, mode: Mode, isSubscription: boolean): AgentoLedger {
  return {
    startedAt: now,
    baselineModel: '',
    isSubscription,
    sevenDayPct: null,
    mode,
    steps: 0,
    cost: 0,
    baselineCost: 0,
    tokens: zeroTokens(),
    byModel: {},
    savedEstimate: { spawnRouting: 0, suggestions: 0, handoff: 0, autopilot: 0 },
    hints: { shown: 0, accepted: 0, dismissed: 0, auto: 0 },
    credit: null,
    handoff: null,
    main: null,
    lineages: {},
    routed: {},
    decisions: [],
    signals: [],
    recent: [],
  };
}

export interface StepInput {
  ts: number;
  lineage: string;
  model: string;
  effort: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  mode: Mode;
  isSubscription: boolean;
  sevenDayPct: number | null;
}

function tokensOf(u: StepInput['usage']): AgentoTokens {
  return { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens };
}

// Which `savedEstimate` bucket a mechanism is credited to.
const SAVED_KEY = { 'spawn-routing': 'spawnRouting', 'suggestion-accepted': 'suggestions', handoff: 'handoff', autopilot: 'autopilot' } as const;

export function savedKey(m: AgentoMechanism): keyof AgentoLedger['savedEstimate'] {
  return SAVED_KEY[m];
}

// A ledger written by an older version may lack the newer buckets.
export function savedOf(l: Pick<AgentoLedger, 'savedEstimate'> | undefined): AgentoLedger['savedEstimate'] {
  const s: Partial<AgentoLedger['savedEstimate']> = l?.savedEstimate ?? {};
  return { spawnRouting: s.spawnRouting ?? 0, suggestions: s.suggestions ?? 0, handoff: s.handoff ?? 0, autopilot: s.autopilot ?? 0 };
}

export function hintsOf(l: Pick<AgentoLedger, 'hints'> | undefined): AgentoHintCounts {
  return l?.hints ?? { shown: 0, accepted: 0, dismissed: 0, auto: 0 };
}

// Pure: folds one observed step into the session ledger. Never reads or decides anything.
export function applyStep(prev: AgentoLedger | undefined, s: StepInput): AgentoLedger {
  const l: AgentoLedger = prev ? { ...prev } : emptyLedger(s.ts, s.mode, s.isSubscription);
  const u = normalizeUsage(s.usage);
  const baselineModel = l.baselineModel || (s.lineage === 'main' ? s.model : '');
  const cost = costOf(s.model, u)?.total ?? null;
  const baselineCost = baselineModel ? (repriceAs(baselineModel, u)?.total ?? null) : cost;

  const routed = s.lineage.startsWith('agent:') ? l.routed[s.lineage.slice('agent:'.length)] : undefined;
  let mechanism: AgentoMechanism | null = null;
  let savedEstimate: number | null = null;
  if (routed) {
    // The same tokens at the parent's price, minus what they cost on the cheaper model. An upper bound.
    const atParent = repriceAs(routed.parentModel, u)?.total ?? null;
    if (atParent !== null && cost !== null) {
      mechanism = 'spawn-routing';
      savedEstimate = Math.max(0, atParent - cost);
    }
  }

  // A main step on the tier agento moved the user to is credited with the price difference against
  // the model they were on: the same tokens at that price, minus what they cost. An estimate, an upper bound.
  let credit: AgentoCredit | null = l.credit ?? null;
  if (credit && s.lineage === 'main') {
    if (tierOf(s.model) !== null && tierOf(s.model) === tierOf(credit.model)) {
      const atFrom = repriceAs(credit.fromModel, u)?.total ?? null;
      if (atFrom !== null && cost !== null) {
        mechanism = credit.mechanism;
        savedEstimate = Math.max(0, atFrom - cost);
      }
    } else {
      // The user went elsewhere (another /model): agento's change no longer explains the cost.
      credit = null;
    }
  }

  const step: AgentoStep = {
    ts: s.ts,
    lineage: s.lineage,
    model: s.model,
    effort: s.effort,
    tokens: tokensOf(s.usage),
    cost,
    baselineCost,
    mechanism,
    savedEstimate,
  };

  l.baselineModel = baselineModel;
  l.mode = s.mode;
  l.isSubscription = s.isSubscription;
  l.sevenDayPct = s.sevenDayPct ?? l.sevenDayPct;
  l.steps += 1;
  l.cost += cost ?? 0;
  l.baselineCost += baselineCost ?? 0;
  l.tokens = {
    input: l.tokens.input + step.tokens.input,
    output: l.tokens.output + step.tokens.output,
    cacheRead: l.tokens.cacheRead + step.tokens.cacheRead,
    cacheWrite: l.tokens.cacheWrite + step.tokens.cacheWrite,
  };
  const m = l.byModel[s.model] ?? { steps: 0, cost: 0 };
  l.byModel = { ...l.byModel, [s.model]: { steps: m.steps + 1, cost: m.cost + (cost ?? 0) } };
  l.credit = credit;
  if (savedEstimate !== null && mechanism !== null) {
    const k = savedKey(mechanism);
    const saved = savedOf(l);
    l.savedEstimate = { ...saved, [k]: saved[k] + savedEstimate };
  }
  if (s.lineage === 'main') {
    l.main = { model: s.model, effort: s.effort };
    if (l.handoff && l.handoff.executorTokens === null && s.ts >= l.handoff.ts) {
      l.handoff = { ...l.handoff, executorTokens: step.tokens.input + step.tokens.cacheRead + step.tokens.cacheWrite };
    }
  }

  const fallbackTtl: Ttl = s.isSubscription ? '1h' : '5m';
  l.lineages = setCapped(l.lineages, s.lineage, nextLineageState(l.lineages[s.lineage], s.model, u, s.ts, fallbackTtl), MAX_AGENT_LINEAGES, (k) => k === 'main');
  l.recent = [...l.recent, step].slice(-MAX_RECENT);
  return l;
}

export type HintKind = keyof AgentoHintCounts;

export function applyHint(prev: AgentoLedger | undefined, kind: HintKind, now: number, mode: Mode, isSubscription: boolean): AgentoLedger {
  const l: AgentoLedger = prev ? { ...prev } : emptyLedger(now, mode, isSubscription);
  const h = hintsOf(l);
  l.hints = { ...h, [kind]: h[kind] + 1 };
  return l;
}

export function applyCredit(prev: AgentoLedger | undefined, credit: AgentoCredit | null, now: number, mode: Mode, isSubscription: boolean): AgentoLedger {
  const l: AgentoLedger = prev ? { ...prev } : emptyLedger(now, mode, isSubscription);
  l.credit = credit;
  return l;
}

export function applyHandoff(prev: AgentoLedger | undefined, rec: AgentoHandoffRecord, mode: Mode, isSubscription: boolean): AgentoLedger {
  const l: AgentoLedger = prev ? { ...prev } : emptyLedger(rec.ts, mode, isSubscription);
  l.handoff = rec;
  return l;
}

// After /clear or a compaction the main thread starts over with an empty cache.
export function dropMainLineage(prev: AgentoLedger): AgentoLedger {
  if (!prev.lineages.main) return prev;
  const { main: _gone, ...rest } = prev.lineages;
  return { ...prev, lineages: rest };
}

export function applyDecision(prev: AgentoLedger | undefined, d: AgentoSpawnDecision, mode: Mode, isSubscription: boolean): AgentoLedger {
  const l: AgentoLedger = prev ? { ...prev } : emptyLedger(d.ts, mode, isSubscription);
  l.routed = setCapped(l.routed, d.agentId, d, MAX_ROUTED);
  l.decisions = [...l.decisions, d].slice(-MAX_DECISIONS);
  return l;
}

export function applySignal(prev: AgentoLedger | undefined, sig: AgentoLoopSignalRecord, mode: Mode, isSubscription: boolean): AgentoLedger {
  const l: AgentoLedger = prev ? { ...prev } : emptyLedger(sig.ts, mode, isSubscription);
  l.signals = [...l.signals, sig].slice(-MAX_SIGNALS);
  return l;
}

// ---- daily aggregates in $.store (one key per day, KEEP_DAYS days) ----

export interface DayAggregate {
  steps: number;
  cost: number;
  baselineCost: number;
  tokens: AgentoTokens;
  byModel: Record<string, { steps: number; cost: number }>;
  savedEstimate: { spawnRouting: number; suggestions: number; handoff: number; autopilot: number };
  routedSpawns: number;
  loopSignals: number;
  hintsShown: number;
  hintsAccepted: number;
  hintsDismissed: number;
  autopilotActions: number;
}

export const emptyDay = (): DayAggregate => ({
  steps: 0,
  cost: 0,
  baselineCost: 0,
  tokens: zeroTokens(),
  byModel: {},
  savedEstimate: { spawnRouting: 0, suggestions: 0, handoff: 0, autopilot: 0 },
  routedSpawns: 0,
  loopSignals: 0,
  hintsShown: 0,
  hintsAccepted: 0,
  hintsDismissed: 0,
  autopilotActions: 0,
});

// A day written by an older version lacks the newer fields.
export function normalizeDay(v: unknown): DayAggregate {
  if (!isDay(v)) return emptyDay();
  return { ...emptyDay(), ...v, savedEstimate: { ...emptyDay().savedEstimate, ...v.savedEstimate } };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `day:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function foldDay(prev: unknown, step: AgentoStep): DayAggregate {
  const d = normalizeDay(prev);
  const m = d.byModel[step.model] ?? { steps: 0, cost: 0 };
  return {
    ...d,
    steps: d.steps + 1,
    cost: d.cost + (step.cost ?? 0),
    baselineCost: d.baselineCost + (step.baselineCost ?? 0),
    tokens: {
      input: d.tokens.input + step.tokens.input,
      output: d.tokens.output + step.tokens.output,
      cacheRead: d.tokens.cacheRead + step.tokens.cacheRead,
      cacheWrite: d.tokens.cacheWrite + step.tokens.cacheWrite,
    },
    byModel: { ...d.byModel, [step.model]: { steps: m.steps + 1, cost: m.cost + (step.cost ?? 0) } },
    savedEstimate: step.mechanism
      ? { ...d.savedEstimate, [savedKey(step.mechanism)]: d.savedEstimate[savedKey(step.mechanism)] + (step.savedEstimate ?? 0) }
      : d.savedEstimate,
  };
}

export function isDay(v: unknown): v is DayAggregate {
  return !!v && typeof v === 'object' && typeof (v as DayAggregate).steps === 'number' && !!(v as DayAggregate).tokens && !!(v as DayAggregate).savedEstimate;
}

// Keys older than KEEP_DAYS are dropped.
export function expiredDayKeys(keys: readonly string[], now: number): string[] {
  const cutoff = dayKey(now - KEEP_DAYS * 86_400_000);
  return keys.filter((k) => k.startsWith('day:') && k < cutoff);
}
