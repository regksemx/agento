// The view-model of the `/agento` pane (spec §7.7). Pure: the hook turns these rows into `Text` and `Button`.
// Every dollar figure is marked `факт` (measured) or `оценка` (estimate), as P6 asks.

import type { AgentoLedger, AgentoPaneRange } from '../types';
import { isWarm, warmRemainingMs, type LineageState } from '../core/cache.ts';
import { tierOf } from '../core/pricing.ts';
import { fmtPct, formatUsd } from './status.ts';
import type { Lang } from './strings.ts';
import { hintsOf, savedOf } from './ledger.ts';

export type Tone = 'plain' | 'dim' | 'accent' | 'success' | 'warning';

export interface Seg {
  text: string;
  tone?: Tone;
}

export interface Row {
  label: string;
  segs: Seg[];
}

export interface PanelData {
  range: AgentoPaneRange;
  now: number;
  mode: string;
  autopilot: string;
  // The configured value, and the value the system prompt was fixed with at session start.
  orchestrate: boolean;
  orchestrateFixed: boolean;
  isSubscription: boolean;
  sevenDayPct: number | null;
  pctPerUsd: number | null;
  startedAt: number;
  steps: number;
  cost: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  byModel: Record<string, { steps: number; cost: number }>;
  saved: { spawnRouting: number; suggestions: number; handoff: number; autopilot: number };
  hints: { shown: number; accepted: number; dismissed: number; auto: number };
  loopSignals: number;
  lastSignal: string | null;
  cache: LineageState | undefined;
  handoff: AgentoLedger['handoff'];
}

export interface PanelModel {
  title: Seg[];
  modeText: string;
  rows: Row[];
  // What the footer buttons say.
  buttons: { mode: string; orchestrate: string; autopilot: string };
  rangeOptions: Array<{ value: AgentoPaneRange; label: string }>;
  note: string | null;
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function bar(n: number, max: number, width = 10): string {
  if (max <= 0 || n <= 0) return '░'.repeat(width);
  const filled = Math.max(1, Math.round((n / max) * width));
  return '▇'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

const TIER_ORDER = ['opus', 'sonnet', 'haiku', 'fable'];

// Steps per model tier, in a fixed order; unknown models are lumped under `other`.
export function tierSteps(byModel: Record<string, { steps: number; cost: number }>): Array<{ name: string; steps: number }> {
  const acc: Record<string, number> = {};
  for (const [model, t] of Object.entries(byModel)) {
    const k = tierOf(model) ?? 'other';
    acc[k] = (acc[k] ?? 0) + t.steps;
  }
  return [...TIER_ORDER, 'other'].filter((k) => (acc[k] ?? 0) > 0).map((k) => ({ name: k, steps: acc[k] ?? 0 }));
}

export function cacheHit(t: PanelData['tokens']): number | null {
  const total = t.input + t.cacheRead + t.cacheWrite;
  return total > 0 ? t.cacheRead / total : null;
}

function savedTotal(s: PanelData['saved']): number {
  return s.spawnRouting + s.suggestions + s.handoff + s.autopilot;
}

export function buildPanel(d: PanelData, lang: Lang): PanelModel {
  const ru = lang === 'ru';
  const fact = ru ? 'факт' : 'measured';
  const est = ru ? 'оценка' : 'estimate';
  const rows: Row[] = [];

  const rangeLabel =
    d.range === 'session'
      ? `${ru ? 'сессия' : 'session'} ${duration(d.now - d.startedAt)}`
      : d.range === 'today'
        ? ru ? 'сегодня' : 'today'
        : d.range === '7d'
          ? ru ? '7 дней' : '7 days'
          : ru ? 'всё время' : 'all time';

  // Spend
  const spend: Seg[] = [{ text: `${formatUsd(d.cost)} ${d.isSubscription ? (ru ? 'API-экв.' : 'API-equiv.') : fact}`, tone: 'plain' }];
  if (d.isSubscription && d.sevenDayPct !== null) spend.push({ text: `  ${ru ? '7д' : '7d'} ${fmtPct(d.sevenDayPct)}`, tone: 'accent' });
  const hit = cacheHit(d.tokens);
  if (hit !== null) spend.push({ text: `   ${ru ? 'кэш hit' : 'cache hit'} ${Math.round(hit * 100)}%`, tone: 'dim' });
  if (d.cache) {
    const warm = isWarm(d.cache, d.now);
    spend.push({ text: warm ? ` · ● warm ${Math.max(1, Math.floor(warmRemainingMs(d.cache, d.now) / 60_000))}m` : ' · ○ cold', tone: warm ? 'success' : 'dim' });
  }
  rows.push({ label: ru ? 'Расход' : 'Spend', segs: spend });

  // Models
  const tiers = tierSteps(d.byModel);
  const max = Math.max(0, ...tiers.map((t) => t.steps));
  const models: Seg[] = [];
  tiers.forEach((t, i) => models.push({ text: `${i > 0 ? '   ' : ''}${t.name} ${bar(t.steps, max, 10)} ${t.steps}`, tone: 'plain' }));
  if (tiers.length === 0) models.push({ text: ru ? 'пока нет шагов' : 'no steps yet', tone: 'dim' });
  rows.push({ label: ru ? 'Модели' : 'Models', segs: models });

  // Savings: only agento's own mechanisms, always an estimate.
  const total = savedTotal(d.saved);
  const parts: string[] = [];
  const add = (v: number, name: string): void => {
    if (v > 0) parts.push(`${name} ${formatUsd(v)}`);
  };
  add(d.saved.spawnRouting, ru ? 'субагенты' : 'subagents');
  add(d.saved.suggestions, ru ? 'подсказки' : 'hints');
  add(d.saved.autopilot, ru ? 'автопилот' : 'autopilot');
  add(d.saved.handoff, 'handoff');
  const savedSegs: Seg[] = [];
  if (total > 0) {
    const head = d.isSubscription && d.pctPerUsd !== null ? `≈ ${fmtPct(total * d.pctPerUsd)} ${ru ? 'недельного лимита' : 'of the weekly limit'}` : `≈ ${formatUsd(total)}`;
    savedSegs.push({ text: head, tone: 'success' }, { text: `  (${parts.join(' · ')})`, tone: 'dim' }, { text: `   ${est}`, tone: 'warning' });
  } else {
    savedSegs.push({ text: ru ? 'пока нечего засчитать' : 'nothing to credit yet', tone: 'dim' });
  }
  rows.push({ label: ru ? 'Экономия' : 'Savings', segs: savedSegs });

  // Hints
  const h = d.hints;
  const hintParts = ru
    ? [`${h.shown} показано`, `${h.accepted} принято`, `${h.dismissed} «не предлагать»`]
    : [`${h.shown} shown`, `${h.accepted} accepted`, `${h.dismissed} "don't suggest"`];
  if (h.auto > 0) hintParts.push(ru ? `${h.auto} авто` : `${h.auto} auto`);
  rows.push({ label: ru ? 'Подсказки' : 'Hints', segs: [{ text: hintParts.join(' · ') }] });

  // Loops
  rows.push({
    label: ru ? 'Буксование' : 'Loops',
    segs: d.loopSignals > 0 ? [{ text: `${d.loopSignals}`, tone: 'warning' }, ...(d.lastSignal ? [{ text: ` (${d.lastSignal})`, tone: 'dim' as Tone }] : [])] : [{ text: ru ? 'нет' : 'none', tone: 'dim' }],
  });

  // Handoff
  if (d.handoff && d.range === 'session') {
    const k = (n: number | null): string => (n === null ? '…' : `${Math.round(n / 1000)}k`);
    rows.push({
      label: 'Handoff',
      segs: [{ text: ru ? `контекст исполнителя ${k(d.handoff.executorTokens)} токенов вместо ${k(d.handoff.plannerTokens)}` : `executor context ${k(d.handoff.executorTokens)} tokens instead of ${k(d.handoff.plannerTokens)}` }, { text: `   ${d.handoff.planPath}`, tone: 'dim' }],
    });
  }

  const orch = d.orchestrate ? (ru ? 'вкл' : 'on') : ru ? 'выкл' : 'off';
  const note = d.orchestrate !== d.orchestrateFixed ? (ru ? 'Оркестр применится с новой сессии (system prompt фиксируется при старте).' : 'Orchestrator mode applies from the next session (the system prompt is fixed at start).') : null;
  return {
    title: [{ text: '◆', tone: 'accent' }, { text: ` agento · ${rangeLabel}` }],
    modeText: `mode: ${d.mode}`,
    rows,
    buttons: { mode: ru ? 'Режим' : 'Mode', orchestrate: `${ru ? 'Оркестр' : 'Orchestra'}: ${orch}`, autopilot: `${ru ? 'Автопилот' : 'Autopilot'}: ${d.autopilot === 'off' ? (ru ? 'выкл' : 'off') : d.autopilot}` },
    rangeOptions: [
      { value: 'session', label: ru ? 'Сессия' : 'Session' },
      { value: 'today', label: ru ? 'Сегодня' : 'Today' },
      { value: '7d', label: ru ? '7 дней' : '7 days' },
      { value: 'all', label: ru ? 'Всё время' : 'All time' },
    ],
    note,
  };
}

// Folds day aggregates (from `$.store`) into the numbers the pane shows for a range.
export function foldDays(days: ReadonlyArray<{
  steps: number; cost: number; tokens: PanelData['tokens']; byModel: PanelData['byModel']; savedEstimate: PanelData['saved'];
  loopSignals: number; hintsShown: number; hintsAccepted: number; hintsDismissed: number; autopilotActions: number;
}>): Pick<PanelData, 'steps' | 'cost' | 'tokens' | 'byModel' | 'saved' | 'hints' | 'loopSignals'> {
  const out = {
    steps: 0, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, byModel: {} as PanelData['byModel'],
    saved: { spawnRouting: 0, suggestions: 0, handoff: 0, autopilot: 0 }, hints: { shown: 0, accepted: 0, dismissed: 0, auto: 0 }, loopSignals: 0,
  };
  for (const d of days) {
    out.steps += d.steps;
    out.cost += d.cost;
    out.tokens = { input: out.tokens.input + d.tokens.input, output: out.tokens.output + d.tokens.output, cacheRead: out.tokens.cacheRead + d.tokens.cacheRead, cacheWrite: out.tokens.cacheWrite + d.tokens.cacheWrite };
    for (const [m, t] of Object.entries(d.byModel)) {
      const p = out.byModel[m] ?? { steps: 0, cost: 0 };
      out.byModel[m] = { steps: p.steps + t.steps, cost: p.cost + t.cost };
    }
    out.saved = { spawnRouting: out.saved.spawnRouting + d.savedEstimate.spawnRouting, suggestions: out.saved.suggestions + d.savedEstimate.suggestions, handoff: out.saved.handoff + d.savedEstimate.handoff, autopilot: out.saved.autopilot + d.savedEstimate.autopilot };
    out.hints = { shown: out.hints.shown + d.hintsShown, accepted: out.hints.accepted + d.hintsAccepted, dismissed: out.hints.dismissed + d.hintsDismissed, auto: out.hints.auto + d.autopilotActions };
    out.loopSignals += d.loopSignals;
  }
  return out;
}

// The session's own numbers, from the ledger.
export function sessionNumbers(l: AgentoLedger): Pick<PanelData, 'steps' | 'cost' | 'tokens' | 'byModel' | 'saved' | 'hints' | 'loopSignals'> {
  return {
    steps: l.steps,
    cost: l.cost,
    tokens: l.tokens,
    byModel: l.byModel,
    saved: savedOf(l),
    hints: hintsOf(l),
    loopSignals: l.signals.length,
  };
}

// The date range a pane range covers, as the day keys to read: `day:YYYY-MM-DD`.
export function rangeDays(range: AgentoPaneRange, now: number, dayKeyOf: (ts: number) => string): { keys: string[] | 'all' } {
  if (range === 'today') return { keys: [dayKeyOf(now)] };
  if (range === '7d') return { keys: Array.from({ length: 7 }, (_, i) => dayKeyOf(now - i * 86_400_000)) };
  return { keys: 'all' };
}
