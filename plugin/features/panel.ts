// The view-model of the `/agento` pane (spec §7.7). Pure: the hook turns these rows into `Text` and `Button`.
// Every dollar figure is marked `факт` (measured) or `оценка` (estimate), as P6 asks.

import type { AgentoBrain, AgentoLedger, AgentoPaneRange, AgentoRoute } from '../types';
import { isWarm, rewriteCost, warmRemainingMs, type LineageState } from '../core/cache.ts';
import { familyOf, tierOf, tierRank } from '../core/pricing.ts';
import { fmtPct, formatUsd } from './status.ts';
import type { Lang } from './strings.ts';
import { hintsOf, savedOf, savedTotal } from './ledger.ts';
import { fmtTokensShort } from './receipt.ts';

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
  saved: { spawnRouting: number; suggestions: number; handoff: number; autopilot: number; prune?: number };
  hints: { shown: number; accepted: number; dismissed: number; auto: number };
  loopSignals: number;
  lastSignal: string | null;
  cache: LineageState | undefined;
  handoff: AgentoLedger['handoff'];
  // What is known of the local classifier daemon; absent before the probe has run.
  brain?: AgentoBrain | undefined;
  // Current state, from the ledger and the task state (all optional: absent in state an older version wrote).
  main?: AgentoLedger['main'];
  task?: { class: string; tier: string | null; cost: number; steps: number } | null;
  // When the weekly limit window resets, as the API gave it (the calibration's newest window); 'unknown' or absent when not known.
  resetsAt?: string | null;
  routes?: AgentoRoute[];
  spawns?: SpawnsView;
  lastSignalKind?: string | null;
  pruned?: { count: number; outputs: number; tokens: number } | null;
  // The running task's cost (all lineages) and its 7-day reading at start.
  taskTotal?: number | null;
  taskPctAtStart?: number | null;
}

// One subagent spawn as the pane shows it. `actual` is set only when the steps ran it on another model than chosen.
export interface SpawnView {
  ts: number;
  type: string;
  parent: string;
  model: string;
  reason: string;
  actual: string | null;
}

export interface SpawnsView {
  recent: SpawnView[];
  total: number;
  // Spawns agento moved to a cheaper tier than the parent's, in all and by target tier.
  cheaper: number;
  cheaperByTier?: Record<string, number>;
}

export interface PanelModel {
  title: Seg[];
  modeText: string;
  settingsLabel: string;
  rangeLabel: string;
  // Headline: savings, what agento did, the task, the limits.
  rows: Row[];
  detailsLabel: string;
  details: Row[];
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


// Who classifies the task at a clean point: the local rules, or the trained model the daemon serves.
export function classifierText(b: AgentoBrain | undefined, lang: Lang): Seg[] {
  const ru = lang === 'ru';
  const rules = ru ? 'rules-v1 · локально' : 'rules-v1 · local';
  if (!b || b.status === 'off' || (b.status === 'up' && b.runId === 'rules-v1')) return [{ text: rules }];
  if (b.status === 'down') return [{ text: rules }, { text: ru ? '  (brain недоступен)' : '  (brain unavailable)', tone: 'dim' }];
  return [{ text: `brain ${b.runId ?? '?'}`, tone: 'success' }, { text: b.p50Ms !== null ? ` · p50 ${b.p50Ms < 10 ? b.p50Ms.toFixed(1) : Math.round(b.p50Ms)} ms` : '', tone: 'dim' }];
}

const MAX_SPAWN_ROWS = 5;
const MAX_ROUTE_ROWS = 3;

// `claude-opus-5-5-20260801[1m]` -> `opus-5-5`; an alias or an unknown id stays as it is.
export function shortModel(m: string): string {
  return m.replace(/\[.*?\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

// Cost per model tier, in the fixed tier order.
export function tierCosts(byModel: Record<string, { steps: number; cost: number }>): Array<{ name: string; cost: number }> {
  const acc: Record<string, number> = {};
  for (const [model, t] of Object.entries(byModel)) {
    const k = tierOf(model) ?? 'other';
    acc[k] = (acc[k] ?? 0) + t.cost;
  }
  return [...TIER_ORDER, 'other'].filter((k) => (acc[k] ?? 0) > 0).map((k) => ({ name: k, cost: acc[k] ?? 0 }));
}

// The most recent spawns from the ledger, newest first, each with the model its steps actually ran on when that
// differs from the one chosen (the step's lineage is `agent:<agentId>`; the steps are the ledger's recent ones).
export function spawnsOf(l: Pick<AgentoLedger, 'decisions' | 'recent'>): SpawnsView {
  const actualOf = (agentId: string): string | null => {
    for (let i = l.recent.length - 1; i >= 0; i--) {
      const s = l.recent[i];
      if (s && s.lineage === `agent:${agentId}`) return s.model;
    }
    return null;
  };
  const differs = (a: string, b: string): boolean => {
    const fa = familyOf(a);
    const fb = familyOf(b);
    return fa !== 'unknown' && fb !== 'unknown' ? fa !== fb : a !== b;
  };
  const cheaperList = l.decisions.filter((d) => {
    const to = tierOf(d.model);
    const from = tierOf(d.parentModel);
    return d.reason !== 'explicit-model' && to !== null && from !== null && tierRank(to) < tierRank(from);
  });
  const cheaperByTier: Record<string, number> = {};
  for (const d of cheaperList) {
    const t = tierOf(d.model) as string;
    cheaperByTier[t] = (cheaperByTier[t] ?? 0) + 1;
  }
  const cheaper = cheaperList.length;
  const recent = l.decisions.slice(-MAX_SPAWN_ROWS).reverse().map((d): SpawnView => {
    const a = actualOf(d.agentId);
    return { ts: d.ts, type: d.subagentType, parent: d.parentModel, model: d.model, reason: d.reason, actual: a !== null && differs(a, d.model) ? a : null };
  });
  return { recent, total: l.decisions.length, cheaper, cheaperByTier };
}

// `in 3d 4h`, `in 5h03m`; null when it cannot be read or is past.
function resetsIn(resetsAt: string | null | undefined, now: number, ru: boolean): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  const rest = d > 0 ? `${d}${ru ? 'д' : 'd'} ${Math.floor((ms % 86_400_000) / 3_600_000)}${ru ? 'ч' : 'h'}` : duration(ms);
  return ru ? `сброс через ${rest}` : `resets in ${rest}`;
}

export function buildPanel(d: PanelData, lang: Lang): PanelModel {
  const ru = lang === 'ru';
  const fact = ru ? 'факт' : 'measured';
  const est = ru ? 'оценка' : 'estimate';
  const rows: Row[] = [];
  const details: Row[] = [];
  const pct = d.isSubscription && d.pctPerUsd !== null ? d.pctPerUsd : null;
  // `1.2% недели` when calibrated, else dollars.
  const amount = (usd: number): string => (pct !== null ? `${fmtPct(usd * pct)} ${ru ? 'недели' : 'of the week'}` : formatUsd(usd));

  const rangeLabel =
    d.range === 'session'
      ? `${ru ? 'сессия' : 'session'} ${duration(d.now - d.startedAt)}`
      : d.range === 'today'
        ? ru ? 'сегодня' : 'today'
        : d.range === '7d'
          ? ru ? '7 дней' : '7 days'
          : ru ? 'всё время' : 'all time';

  const ago = (ts: number): string => `${duration(d.now - ts)} ${ru ? 'назад' : 'ago'}`;
  const scope: Seg[] = d.range === 'session' ? [] : [{ text: ru ? '  (сессия)' : '  (session)', tone: 'dim' }];

  // Saved: the one number
  const saved = savedOf({ savedEstimate: d.saved });
  const total = savedTotal(saved);
  if (total > 0) {
    const segs: Seg[] = [{ text: `≈ ${amount(total)}`, tone: 'success' }];
    if (pct !== null) segs.push({ text: `  (${formatUsd(total)} ${ru ? 'API-экв.' : 'API-equiv.'})`, tone: 'dim' });
    segs.push({ text: `   ${est}`, tone: 'warning' });
    rows.push({ label: ru ? 'Сэкономлено' : 'Saved', segs });
  } else {
    rows.push({ label: ru ? 'Сэкономлено' : 'Saved', segs: [{ text: ru ? 'пока нечего засчитать' : 'nothing to credit yet', tone: 'dim' }] });
  }

  // What agento did
  const did: Seg[][] = [];
  const line = (what: string, usd: number): Seg[] => [{ text: what }, ...(usd > 0 ? [{ text: ` — ≈${amount(usd)}`, tone: 'success' as Tone }] : [])];
  const h = d.hints;
  if (saved.autopilot > 0 || h.auto > 0) did.push(line(ru ? `автопилот: модель дешевле${h.auto > 0 ? ` ×${h.auto}` : ''}` : `autopilot: cheaper model${h.auto > 0 ? ` ×${h.auto}` : ''}`, saved.autopilot));
  const byTier = Object.entries(d.spawns?.cheaperByTier ?? {}).filter(([, n]) => n > 0).map(([t, n]) => `${t} ×${n}`);
  if (saved.spawnRouting > 0 || byTier.length > 0) did.push(line(ru ? `субагенты${byTier.length ? `: ${byTier.join(', ')}` : ' на дешёвых моделях'}` : `subagents${byTier.length ? `: ${byTier.join(', ')}` : ' on cheaper models'}`, saved.spawnRouting));
  if (saved.handoff > 0 || (d.handoff && d.range === 'session')) did.push(line(ru ? 'код по плану на Sonnet' : 'plan coded on Sonnet', saved.handoff));
  if (saved.suggestions > 0) did.push(line(ru ? `принятые подсказки${h.accepted > 0 ? ` ×${h.accepted}` : ''}` : `accepted suggestions${h.accepted > 0 ? ` ×${h.accepted}` : ''}`, saved.suggestions));
  const pr = d.pruned;
  if (saved.prune > 0 || (pr && pr.count > 0)) did.push(line(ru ? `убраны старые выводы${pr ? ` ×${pr.outputs} (−${fmtTokensShort(pr.tokens)} токенов)` : ''}` : `pruned stale outputs${pr ? ` ×${pr.outputs} (−${fmtTokensShort(pr.tokens)} tokens)` : ''}`, saved.prune));
  if (d.loopSignals > 0) did.push([{ text: ru ? `предупредил о буксовании ×${d.loopSignals}` : `flagged a stuck agent ×${d.loopSignals}`, tone: 'warning' }, ...(d.lastSignal ? [{ text: `  (${d.lastSignal})`, tone: 'dim' as Tone }] : [])]);
  const didLabel = ru ? 'Что сделал' : 'What it did';
  if (did.length === 0) rows.push({ label: didLabel, segs: [{ text: ru ? 'пока ничего' : 'nothing yet', tone: 'dim' }] });
  did.forEach((segs, i) => rows.push({ label: i === 0 ? didLabel : '', segs }));

  // The running task
  if (d.task) {
    const t = d.task;
    const usd = d.taskTotal ?? t.cost;
    const start = d.taskPctAtStart;
    const share = d.isSubscription && start !== null && start !== undefined && d.sevenDayPct !== null && d.sevenDayPct >= start ? `${fmtPct(Math.max(d.sevenDayPct - start, 0.01))} ${ru ? 'недели' : 'of the week'}` : amount(usd);
    rows.push({ label: ru ? 'Задача' : 'Task', segs: [{ text: share, tone: 'accent' }, { text: ` · ${t.steps} ${ru ? 'шагов' : 'steps'}${t.tier ? ` · ${t.tier}` : ''}`, tone: 'dim' }] });
  }

  // Limits: subscribers only (the 5-hour window is not in the ledger)
  if (d.isSubscription) {
    const ls: Seg[] = [];
    if (d.sevenDayPct !== null) {
      ls.push({ text: `${ru ? '7д' : '7d'} ${bar(d.sevenDayPct, 100, 10)} ${fmtPct(d.sevenDayPct)}`, tone: 'accent' });
      const reset = resetsIn(d.resetsAt, d.now, ru);
      if (reset) ls.push({ text: ` · ${reset}`, tone: 'dim' });
    } else {
      ls.push({ text: ru ? 'пока нет данных' : 'no reading yet', tone: 'dim' });
    }
    rows.push({ label: ru ? 'Лимиты' : 'Limits', segs: ls });
  }

  // ---- details ----

  const spend: Seg[] = [{ text: `${formatUsd(d.cost)} ${d.isSubscription ? (ru ? 'API-экв.' : 'API-equiv.') : fact}`, tone: 'plain' }];
  const hit = cacheHit(d.tokens);
  if (hit !== null) spend.push({ text: `   ${ru ? 'кэш hit' : 'cache hit'} ${Math.round(hit * 100)}%`, tone: 'dim' });
  details.push({ label: ru ? 'Расход' : 'Spend', segs: spend });

  if (d.main) details.push({ label: ru ? 'Модель' : 'Model', segs: [{ text: `${shortModel(d.main.model)}${d.main.effort ? `·${d.main.effort}` : ''}`, tone: 'accent' }] });

  const tiers = tierSteps(d.byModel);
  const max = Math.max(0, ...tiers.map((t) => t.steps));
  const models: Seg[] = [];
  tiers.forEach((t, i) => models.push({ text: `${i > 0 ? '   ' : ''}${t.name} ${bar(t.steps, max, 10)} ${t.steps}`, tone: 'plain' }));
  if (tiers.length === 0) models.push({ text: ru ? 'пока нет шагов' : 'no steps yet', tone: 'dim' });
  details.push({ label: ru ? 'Модели' : 'Models', segs: models });
  const costs = tierCosts(d.byModel);
  const costSum = costs.reduce((a, c) => a + c.cost, 0);
  if (costSum > 0) details.push({ label: ru ? 'По моделям' : 'By model', segs: [{ text: costs.map((c) => `${c.name} ${formatUsd(c.cost)} ${Math.round((c.cost / costSum) * 100)}%`).join(' · ') }] });
  const tk = d.tokens;
  if (tk.input + tk.output + tk.cacheRead + tk.cacheWrite > 0) {
    details.push({ label: ru ? 'Токены' : 'Tokens', segs: [{ text: `in ${fmtTokens(tk.input)} · out ${fmtTokens(tk.output)}`, tone: 'plain' }, { text: `   ${ru ? 'кэш' : 'cache'} ${ru ? 'чтение' : 'read'} ${fmtTokens(tk.cacheRead)} · ${ru ? 'запись' : 'write'} ${fmtTokens(tk.cacheWrite)}`, tone: 'dim' }] });
  }

  if (d.cache) {
    const warm = isWarm(d.cache, d.now);
    const cs: Seg[] = [{ text: warm ? `● warm ${Math.max(1, Math.floor(warmRemainingMs(d.cache, d.now) / 60_000))}m` : '○ cold', tone: warm ? 'success' : 'dim' }, { text: ` · ${ru ? 'префикс' : 'prefix'} ${fmtTokens(d.cache.prefixTokens)} · ttl ${d.cache.ttl}`, tone: 'plain' }];
    const restart = rewriteCost(d.cache.model, d.cache.prefixTokens, d.cache.ttl);
    if (restart !== null) cs.push({ text: `  ${ru ? 'холодный старт' : 'cold restart'} ≈ ${formatUsd(restart)}`, tone: 'dim' });
    details.push({ label: ru ? 'Кэш' : 'Cache', segs: cs });
  }

  const routes = (d.routes ?? []).slice(-MAX_ROUTE_ROWS).reverse();
  const routeLabel = ru ? 'Маршрут' : 'Routing';
  if (routes.length === 0) details.push({ label: routeLabel, segs: [{ text: ru ? 'пока нет' : 'none yet', tone: 'dim' }] });
  routes.forEach((r, i) => {
    const segs: Seg[] = [{ text: `${ago(r.ts)}  `, tone: 'dim' }, { text: r.classifier }, { text: ` · ${r.tier}·${r.effort}`, tone: 'accent' }];
    segs.push({ text: r.stage === 'trajectory' ? ` · ${ru ? 'траектория' : 'trajectory'} ${r.complexity ?? '?'}` : ` · ${Math.round(r.confidence * 100)}%`, tone: 'plain' });
    if (r.planFirst) segs.push({ text: ' · plan-first', tone: 'plain' });
    if (r.delegateExplore) segs.push({ text: ' · delegate-explore', tone: 'plain' });
    if (r.fallback) segs.push({ text: ` · fallback ${r.fallback}`, tone: 'dim' });
    segs.push({ text: ` → ${r.action}`, tone: 'success' });
    if (i === 0) segs.push(...scope);
    details.push({ label: i === 0 ? routeLabel : '', segs });
  });

  const sp = d.spawns;
  if (!sp || sp.total === 0) {
    details.push({ label: ru ? 'Субагенты' : 'Subagents', segs: [{ text: ru ? 'пока нет' : 'none yet', tone: 'dim' }] });
  } else {
    details.push({
      label: ru ? 'Субагенты' : 'Subagents',
      segs: [{ text: ru ? `${sp.total} запусков · ${sp.cheaper} дешевле родителя` : `${sp.total} spawns · ${sp.cheaper} routed cheaper`, tone: 'plain' }, ...scope],
    });
    for (const v of sp.recent) {
      const kept = v.model === v.parent;
      const segs: Seg[] = [{ text: `${ago(v.ts)}  `, tone: 'dim' }, { text: v.type }];
      segs.push(kept ? { text: `  ${shortModel(v.parent)} · ${ru ? 'оставлена' : 'kept'}`, tone: 'dim' } : { text: `  ${shortModel(v.parent)} → ${shortModel(v.model)}`, tone: 'success' });
      segs.push({ text: ` · ${v.reason}`, tone: 'dim' });
      if (v.actual) segs.push({ text: `  ${ru ? 'шёл на' : 'ran on'} ${shortModel(v.actual)}`, tone: 'warning' });
      details.push({ label: '', segs });
    }
  }

  details.push({ label: ru ? 'Классификатор' : 'Classifier', segs: classifierText(d.brain, lang) });

  if (d.handoff && d.range === 'session') {
    const k = (n: number | null): string => (n === null ? '…' : `${Math.round(n / 1000)}k`);
    details.push({
      label: 'Handoff',
      segs: [{ text: ru ? `контекст исполнителя ${k(d.handoff.executorTokens)} токенов вместо ${k(d.handoff.plannerTokens)}` : `executor context ${k(d.handoff.executorTokens)} tokens instead of ${k(d.handoff.plannerTokens)}` }, { text: `   ${d.handoff.planPath}`, tone: 'dim' }],
    });
  }

  const orch = d.orchestrate ? (ru ? 'вкл' : 'on') : ru ? 'выкл' : 'off';
  const note = d.orchestrate !== d.orchestrateFixed ? (ru ? 'Оркестр применится с новой сессии (system prompt фиксируется при старте).' : 'Orchestrator mode applies from the next session (the system prompt is fixed at start).') : null;
  return {
    title: [{ text: '◆', tone: 'accent' }, { text: ` agento · ${rangeLabel}` }],
    modeText: `mode: ${d.mode}`,
    settingsLabel: ru ? 'Настройки' : 'Settings',
    rangeLabel: ru ? 'Период' : 'Period',
    rows,
    detailsLabel: ru ? 'Подробности' : 'Details',
    details,
    buttons: { mode: ru ? 'Режим' : 'Mode', orchestrate: `${ru ? 'Оркестр' : 'Orchestra'}: ${orch}`, autopilot: `${ru ? 'Автопилот' : 'Autopilot'}: ${d.autopilot === 'off' ? (ru ? 'выкл' : 'off') : ru ? 'вкл' : 'on'}` },
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
    saved: { spawnRouting: 0, suggestions: 0, handoff: 0, autopilot: 0, prune: 0 }, hints: { shown: 0, accepted: 0, dismissed: 0, auto: 0 }, loopSignals: 0,
  };
  for (const d of days) {
    out.steps += d.steps;
    out.cost += d.cost;
    out.tokens = { input: out.tokens.input + d.tokens.input, output: out.tokens.output + d.tokens.output, cacheRead: out.tokens.cacheRead + d.tokens.cacheRead, cacheWrite: out.tokens.cacheWrite + d.tokens.cacheWrite };
    for (const [m, t] of Object.entries(d.byModel)) {
      const p = out.byModel[m] ?? { steps: 0, cost: 0 };
      out.byModel[m] = { steps: p.steps + t.steps, cost: p.cost + t.cost };
    }
    out.saved = { spawnRouting: out.saved.spawnRouting + d.savedEstimate.spawnRouting, suggestions: out.saved.suggestions + d.savedEstimate.suggestions, handoff: out.saved.handoff + d.savedEstimate.handoff, autopilot: out.saved.autopilot + d.savedEstimate.autopilot, prune: (out.saved.prune ?? 0) + (d.savedEstimate.prune ?? 0) };
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
