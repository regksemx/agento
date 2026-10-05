import { describe, expect, it } from 'vitest';
import type { LineageState } from '../core/cache.ts';
import type { AgentoRoute, AgentoSpawnDecision, AgentoStep } from '../types';
import { bar, buildPanel, classifierText, cacheHit, duration, foldDays, shortModel, spawnsOf, tierCosts, tierSteps, type PanelData } from './panel.ts';

const NOW = 1_760_000_000_000;
const cache: LineageState = { model: 'claude-opus-5-5', prefixTokens: 100_000, lastAt: NOW - 60_000, ttl: '1h' };

function data(over: Partial<PanelData> = {}): PanelData {
  return {
    range: 'session',
    now: NOW,
    mode: 'balanced',
    autopilot: 'off',
    orchestrate: false,
    orchestrateFixed: false,
    isSubscription: false,
    sevenDayPct: null,
    pctPerUsd: null,
    startedAt: NOW - (72 * 60_000),
    steps: 142,
    cost: 6.71,
    tokens: { input: 600, output: 20_000, cacheRead: 940_000, cacheWrite: 60_000 },
    byModel: { 'claude-opus-5-5': { steps: 31, cost: 3 }, 'claude-sonnet-5-5': { steps: 84, cost: 2.7 }, 'claude-haiku-4-5': { steps: 27, cost: 1 } },
    saved: { spawnRouting: 1.3, suggestions: 0.82, handoff: 0, autopilot: 0 },
    hints: { shown: 4, accepted: 2, dismissed: 1, auto: 0 },
    loopSignals: 1,
    lastSignal: 'auth.spec падает 3 раза',
    cache,
    handoff: null,
    ...over,
  };
}

const all = (m: ReturnType<typeof buildPanel>) => [...m.rows, ...m.details];
const text = (m: ReturnType<typeof buildPanel>, label: string): string => (all(m).find((r) => r.label === label)?.segs ?? []).map((s) => s.text).join('');

describe('the /agento pane (spec §7.7 mock)', () => {
  const m = buildPanel(data(), 'ru');
  it('header: the mark, the session length, the mode', () => {
    expect(m.title.map((t) => t.text).join('')).toBe('◆ agento · сессия 1h12m');
    expect(m.title[0]).toEqual({ text: '◆', tone: 'accent' });
    expect(m.modeText).toBe('mode: balanced');
  });
  it('leads with one savings number, marked as an estimate', () => {
    expect(m.rows[0]?.label).toBe('Сэкономлено');
    expect(text(m, 'Сэкономлено')).toBe('≈ $2.12   оценка');
    expect(m.rows[0]?.segs.map((x) => x.tone)).toEqual(['success', 'warning']);
  });
  it('then what agento did, each with its amount', () => {
    expect(rowsOf(m, 'Что сделал')).toEqual(['субагенты на дешёвых моделях — ≈$1.30', 'принятые подсказки ×2 — ≈$0.82', 'предупредил о буксовании ×1  (auth.spec падает 3 раза)']);
  });
  it('raw metrics live under the details', () => {
    expect(m.detailsLabel).toBe('Подробности');
    expect(text(m, 'Расход')).toBe('$6.71 факт   кэш hit 94%');
    expect(text(m, 'Модели')).toBe('opus ▇▇▇▇░░░░░░ 31   sonnet ▇▇▇▇▇▇▇▇▇▇ 84   haiku ▇▇▇░░░░░░░ 27');
    expect(m.rows.some((r) => r.label === 'Расход' || r.label === 'Подсказки')).toBe(false);
  });
  it('footer: buttons name the current settings; range options', () => {
    expect(m.buttons).toEqual({ mode: 'Режим', orchestrate: 'Оркестр: выкл', autopilot: 'Автопилот: выкл' });
    expect(buildPanel(data({ autopilot: 'clean-points' }), 'ru').buttons.autopilot).toBe('Автопилот: вкл');
    expect(m.rangeOptions.map((o) => o.value)).toEqual(['session', 'today', '7d', 'all']);
  });

  it('nothing yet: says so', () => {
    const c = buildPanel(data({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, steps: 0, byModel: {}, hints: { shown: 0, accepted: 0, dismissed: 0, auto: 0 }, loopSignals: 0, lastSignal: null, saved: { spawnRouting: 0, suggestions: 0, handoff: 0, autopilot: 0 } }), 'en');
    expect(text(c, 'Saved')).toBe('nothing to credit yet');
    expect(text(c, 'What it did')).toBe('nothing yet');
    expect(text(c, 'Models')).toBe('no steps yet');
  });

  it('a calibrated subscriber sees savings as a share of the week, dollars beside it', () => {
    const sub = buildPanel(data({ isSubscription: true, sevenDayPct: 63.4, pctPerUsd: 4 }), 'ru');
    expect(text(sub, 'Сэкономлено')).toBe('≈ 8.5% недели  ($2.12 API-экв.)   оценка');
    expect(rowsOf(sub, 'Что сделал')[0]).toBe('субагенты на дешёвых моделях — ≈5.2% недели');
    expect(text(sub, 'Расход')).toContain('API-экв.');
    const nocal = buildPanel(data({ isSubscription: true, sevenDayPct: 10, pctPerUsd: null }), 'ru');
    expect(text(nocal, 'Сэкономлено')).toBe('≈ $2.12   оценка');
  });

  it('autopilot, handoff and pruning are named; handoff details stay below', () => {
    const h = buildPanel(data({ saved: { spawnRouting: 0, suggestions: 0, handoff: 0.4, autopilot: 0.2, prune: 0.05 }, hints: { shown: 3, accepted: 1, dismissed: 0, auto: 2 }, loopSignals: 0, pruned: { count: 1, outputs: 4, tokens: 12_000 }, handoff: { ts: NOW, planPath: '.agento/plans/p.md', plannerTokens: 142_000, executorTokens: 9_000 } }), 'ru');
    expect(rowsOf(h, 'Что сделал')).toEqual(['автопилот: модель дешевле ×2 — ≈$0.20', 'код по плану на Sonnet — ≈$0.40', 'убраны старые выводы ×4 (−12k токенов) — ≈$0.05']);
    expect(text(h, 'Handoff')).toBe('контекст исполнителя 9k токенов вместо 142k   .agento/plans/p.md');
  });

  it('cheaper subagents are counted by tier', () => {
    const v = buildPanel(data({ spawns: { recent: [], total: 4, cheaper: 3, cheaperByTier: { haiku: 2, sonnet: 1 } } }), 'en');
    expect(rowsOf(v, 'What it did')[0]).toBe('subagents: haiku ×2, sonnet ×1 — ≈$1.30');
  });

  it('orchestrate changed this session: says it applies from the next one', () => {
    expect(buildPanel(data({ orchestrate: true, orchestrateFixed: false }), 'ru').note).toContain('с новой сессии');
    expect(buildPanel(data({ orchestrate: true, orchestrateFixed: true }), 'ru').note).toBeNull();
    expect(buildPanel(data({ orchestrate: true }), 'ru').buttons.orchestrate).toBe('Оркестр: вкл');
  });

  it('other ranges are named by the range, not by the session', () => {
    expect(buildPanel(data({ range: 'today' }), 'ru').title.map((t) => t.text).join('')).toBe('◆ agento · сегодня');
    expect(buildPanel(data({ range: '7d' }), 'en').title.map((t) => t.text).join('')).toBe('◆ agento · 7 days');
    expect(buildPanel(data({ range: 'all' }), 'ru').title.map((t) => t.text).join('')).toBe('◆ agento · всё время');
  });
});

describe('panel helpers', () => {
  it('bars', () => {
    expect(bar(0, 10)).toBe('░░░░░░░░░░');
    expect(bar(10, 10)).toBe('▇▇▇▇▇▇▇▇▇▇');
    expect(bar(1, 100)).toBe('▇░░░░░░░░░');
  });
  it('durations', () => {
    expect(duration(5 * 60_000)).toBe('5m');
    expect(duration(61 * 60_000)).toBe('1h01m');
    expect(duration(-5)).toBe('0m');
  });
  it('tiers lump versions together; unknown models are "other"', () => {
    expect(tierSteps({ 'claude-opus-5-5': { steps: 2, cost: 1 }, 'claude-opus-4-8': { steps: 3, cost: 1 }, 'gateway-x': { steps: 1, cost: 0 } })).toEqual([{ name: 'opus', steps: 5 }, { name: 'other', steps: 1 }]);
  });
  it('cache hit', () => {
    expect(cacheHit({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHit({ input: 100, output: 0, cacheRead: 900, cacheWrite: 0 })).toBeCloseTo(0.9, 9);
  });
  it('days fold into one range', () => {
    const day = (steps: number, cost: number) => ({
      steps, cost, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, byModel: { 'claude-opus-5-5': { steps, cost } },
      savedEstimate: { spawnRouting: 0.5, suggestions: 0.1, handoff: 0, autopilot: 0.2 }, loopSignals: 1, hintsShown: 2, hintsAccepted: 1, hintsDismissed: 0, autopilotActions: 1,
    });
    const f = foldDays([day(2, 1), day(3, 2)]);
    expect(f.steps).toBe(5);
    expect(f.cost).toBe(3);
    expect(f.tokens.cacheRead).toBe(6);
    expect(f.byModel['claude-opus-5-5']).toEqual({ steps: 5, cost: 3 });
    expect(f.saved).toEqual({ spawnRouting: 1, suggestions: 0.2, handoff: 0, autopilot: 0.4, prune: 0 });
    expect(f.hints).toEqual({ shown: 4, accepted: 2, dismissed: 0, auto: 2 });
    expect(f.loopSignals).toBe(2);
  });
});

describe('classifierText: who classifies', () => {
  const up = { status: 'up' as const, runId: 'run-7', backend: 'onnx', p50Ms: 3.2, checkedAt: NOW, socket: '/s' };
  const text = (b: Parameters<typeof classifierText>[0], lang: 'ru' | 'en') => classifierText(b, lang).map((s) => s.text).join('');
  it('the daemon, with its run and p50', () => {
    expect(text(up, 'en')).toBe('brain run-7 · p50 3.2 ms');
    expect(text({ ...up, p50Ms: 12.6 }, 'ru')).toBe('brain run-7 · p50 13 ms');
  });
  it('rules-v1, local: no daemon, off, or a daemon that serves only the rules', () => {
    expect(text(undefined, 'ru')).toBe('rules-v1 · локально');
    expect(text({ ...up, status: 'off' }, 'ru')).toBe('rules-v1 · локально');
    expect(text({ ...up, runId: 'rules-v1' }, 'en')).toBe('rules-v1 · local');
  });
  it('a daemon that is down is said so', () => {
    expect(text({ ...up, status: 'down' }, 'en')).toBe('rules-v1 · local  (brain unavailable)');
  });
});

const decision = (over: Partial<AgentoSpawnDecision> = {}): AgentoSpawnDecision => ({ ts: NOW - 120_000, agentId: 'a1', subagentType: 'Explore', parentModel: 'claude-opus-5-5', model: 'haiku', reason: 'explore', mechanism: 'spawn-routing', ...over });
const step = (lineage: string, model: string): AgentoStep => ({ ts: NOW - 60_000, lineage, model, effort: null, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, baselineCost: 0.02, mechanism: null, savedEstimate: null });
const rowsOf = (m: ReturnType<typeof buildPanel>, label: string) => {
  const rs = all(m);
  const i = rs.findIndex((r) => r.label === label);
  const out = [rs[i]];
  for (let j = i + 1; j < rs.length && rs[j]?.label === ''; j++) out.push(rs[j]);
  return out.filter((r): r is NonNullable<typeof r> => !!r).map((r) => r.segs.map((x) => x.text).join(''));
};

describe('spawnsOf: which model each subagent was launched with', () => {
  it('newest first, at most five, with counts of spawns and of those routed cheaper', () => {
    const ds = Array.from({ length: 7 }, (_, i) => decision({ agentId: `a${i}`, ts: NOW - (7 - i) * 60_000 }));
    ds[0] = decision({ agentId: 'a0', model: 'claude-opus-5-5' });
    const v = spawnsOf({ decisions: ds, recent: [] });
    expect(v.recent.map((r) => r.ts)).toEqual([NOW - 60_000, NOW - 2 * 60_000, NOW - 3 * 60_000, NOW - 4 * 60_000, NOW - 5 * 60_000]);
    expect(v.total).toBe(7);
    expect(v.cheaper).toBe(6);
  });
  it('the actual model shows only when it differs from the chosen one (an alias equals its id)', () => {
    const l = {
      decisions: [decision({ agentId: 'a1', model: 'haiku' }), decision({ agentId: 'a2', model: 'sonnet' }), decision({ agentId: 'a3' })],
      recent: [step('agent:a1', 'claude-sonnet-5-5'), step('agent:a2', 'claude-sonnet-5-5'), step('main', 'claude-opus-5-5')],
    };
    expect(spawnsOf(l).recent.map((r) => r.actual)).toEqual([null, null, 'claude-sonnet-5-5']);
  });
  it('an explicit model is not counted as routed', () => {
    expect(spawnsOf({ decisions: [decision({ model: 'haiku', reason: 'explicit-model' })], recent: [] }).cheaper).toBe(0);
  });
});

describe('the Subagents section', () => {
  const spawns = spawnsOf({
    decisions: [decision({ agentId: 'a1', ts: NOW - 600_000 }), decision({ agentId: 'a2', subagentType: 'general-purpose', model: 'claude-opus-5-5', reason: 'not-cheaper-than-parent' })],
    recent: [step('agent:a1', 'claude-sonnet-5-5')],
  });
  it('en: rewritten, kept and actual-differs rows, newest first, behind a count line', () => {
    const r = rowsOf(buildPanel(data({ spawns }), 'en'), 'Subagents');
    expect(r).toEqual([
      '2 spawns · 1 routed cheaper',
      '2m ago  general-purpose  opus-5-5 · kept · not-cheaper-than-parent',
      '10m ago  Explore  opus-5-5 → haiku · explore  ran on sonnet-5-5',
    ]);
  });
  it('ru: the same, in Russian', () => {
    const r = rowsOf(buildPanel(data({ spawns }), 'ru'), 'Субагенты');
    expect(r[0]).toBe('2 запусков · 1 дешевле родителя');
    expect(r[1]).toContain('opus-5-5 · оставлена');
    expect(r[2]).toContain('шёл на sonnet-5-5');
  });
  it('empty: says none yet; another period tags the numbers as the session\'s', () => {
    expect(rowsOf(buildPanel(data(), 'en'), 'Subagents')).toEqual(['none yet']);
    expect(rowsOf(buildPanel(data({ spawns: { recent: [], total: 0, cheaper: 0 } }), 'ru'), 'Субагенты')).toEqual(['пока нет']);
    expect(rowsOf(buildPanel(data({ spawns, range: 'today' }), 'en'), 'Subagents')[0]).toBe('2 spawns · 1 routed cheaper  (session)');
  });
  it('tones: a rewrite is success, a kept spawn dim, a differing actual a warning', () => {
    const m = buildPanel(data({ spawns }), 'en');
    const rs = all(m);
    const i = rs.findIndex((r) => r.label === 'Subagents');
    expect(rs[i + 1]?.segs.find((s) => s.text.includes('kept'))?.tone).toBe('dim');
    expect(rs[i + 2]?.segs.find((s) => s.text.includes('→'))?.tone).toBe('success');
    expect(rs[i + 2]?.segs.find((s) => s.text.includes('ran on'))?.tone).toBe('warning');
  });
});

describe('the richer pane', () => {
  it('Task: its cost and steps up top; the model in the details', () => {
    const m = buildPanel(data({ main: { model: 'claude-opus-5-5', effort: 'high' }, task: { class: 'refactor', tier: 'sonnet', cost: 0.41, steps: 12 }, taskTotal: 0.6 }), 'en');
    expect(text(m, 'Task')).toBe('$0.60 · 12 steps · sonnet');
    expect(text(m, 'Model')).toBe('opus-5-5·high');
    const sub = buildPanel(data({ isSubscription: true, sevenDayPct: 40.6, pctPerUsd: 4, task: { class: 'x', tier: null, cost: 0.1, steps: 3 }, taskPctAtStart: 40 }), 'ru');
    expect(text(sub, 'Задача')).toBe('0.6% недели · 3 шагов');
    expect(all(buildPanel(data(), 'en')).some((r) => r.label === 'Task' || r.label === 'Model')).toBe(false);
  });
  it('Cache: state, prefix and the price of a cold restart', () => {
    expect(text(buildPanel(data(), 'en'), 'Cache')).toBe('● warm 58m · prefix 100k · ttl 1h  cold restart ≈ $0.80');
    expect(text(buildPanel(data({ cache: { ...cache, lastAt: NOW - 2 * 3_600_000 } }), 'ru'), 'Кэш')).toBe('○ cold · префикс 100k · ttl 1h  холодный старт ≈ $0.80');
    expect(all(buildPanel(data({ cache: undefined }), 'en')).some((r) => r.label === 'Cache')).toBe(false);
  });
  it('Limits: subscribers only; the 7-day window with its reset', () => {
    const reset = new Date(NOW + 3 * 86_400_000 + 4 * 3_600_000).toISOString();
    expect(text(buildPanel(data({ isSubscription: true, sevenDayPct: 63.4, resetsAt: reset }), 'en'), 'Limits')).toBe('7d ▇▇▇▇▇▇░░░░ 63% · resets in 3d 4h');
    expect(text(buildPanel(data({ isSubscription: true, sevenDayPct: 63.4, resetsAt: reset }), 'ru'), 'Лимиты')).toBe('7д ▇▇▇▇▇▇░░░░ 63% · сброс через 3д 4ч');
    expect(text(buildPanel(data({ isSubscription: true, sevenDayPct: 5, resetsAt: 'unknown' }), 'en'), 'Limits')).toBe('7d ▇░░░░░░░░░ 5.0%');
    expect(text(buildPanel(data({ isSubscription: true }), 'en'), 'Limits')).toBe('no reading yet');
    expect(buildPanel(data(), 'en').rows.some((r) => r.label === 'Limits')).toBe(false);
  });
  it('By model: cost and share per tier; Tokens: in, out and cache', () => {
    const m = buildPanel(data(), 'en');
    expect(text(m, 'By model')).toBe('opus $3.00 45% · sonnet $2.70 40% · haiku $1.00 15%');
    expect(text(m, 'Tokens')).toBe('in 600 · out 20k   cache read 940k · write 60k');
    expect(text(buildPanel(data(), 'ru'), 'По моделям')).toContain('opus $3.00 45%');
    const empty = buildPanel(data({ byModel: {}, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), 'en');
    expect(all(empty).some((r) => r.label === 'By model' || r.label === 'Tokens')).toBe(false);
    expect(tierCosts({ 'claude-opus-5-5': { steps: 1, cost: 1 }, 'claude-opus-4-8': { steps: 1, cost: 2 }, x: { steps: 1, cost: 0.5 } })).toEqual([{ name: 'opus', cost: 3 }, { name: 'other', cost: 0.5 }]);
  });
  it('Routing: the last three decisions newest first, with flags and the action; none yet when empty', () => {
    const route = (over: Partial<AgentoRoute>): AgentoRoute => ({ ts: NOW - 300_000, classifier: 'rules-v1', tier: 'sonnet', effort: 'medium', confidence: 0.82, action: 'S1', ...over });
    const routes = [route({ ts: NOW - 900_000 }), route({ classifier: 'brain:run-7', planFirst: true, delegateExplore: true, ts: NOW - 600_000, fallback: undefined }), route({ stage: 'trajectory', complexity: 'large', confidence: 0, action: 'none', ts: NOW - 120_000 }), route({ tier: 'haiku', effort: 'low', action: 'autopilot', ts: NOW - 60_000 })];
    expect(rowsOf(buildPanel(data({ routes }), 'en'), 'Routing')).toEqual([
      '1m ago  rules-v1 · haiku·low · 82% → autopilot',
      '2m ago  rules-v1 · sonnet·medium · trajectory large → none',
      '10m ago  brain:run-7 · sonnet·medium · 82% · plan-first · delegate-explore → S1',
    ]);
    expect(rowsOf(buildPanel(data({ routes: [route({ fallback: 'timeout' })] }), 'ru'), 'Маршрут')[0]).toBe('5m назад  rules-v1 · sonnet·medium · 82% · fallback timeout → S1');
    expect(rowsOf(buildPanel(data(), 'en'), 'Routing')).toEqual(['none yet']);
    expect(rowsOf(buildPanel(data(), 'ru'), 'Маршрут')).toEqual(['пока нет']);
  });
  it('shortModel', () => {
    expect(shortModel('claude-opus-5-5-20260801[1m]')).toBe('opus-5-5');
    expect(shortModel('sonnet')).toBe('sonnet');
  });
});
