import { describe, expect, it } from 'vitest';
import type { LineageState } from '../core/cache.ts';
import { bar, buildPanel, cacheHit, duration, foldDays, tierSteps, type PanelData } from './panel.ts';

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

const text = (m: ReturnType<typeof buildPanel>, label: string): string => (m.rows.find((r) => r.label === label)?.segs ?? []).map((s) => s.text).join('');

describe('the /agento pane (spec §7.7 mock)', () => {
  const m = buildPanel(data(), 'ru');
  it('header: the mark, the session length, the mode', () => {
    expect(m.title.map((t) => t.text).join('')).toBe('◆ agento · сессия 1h12m');
    expect(m.title[0]).toEqual({ text: '◆', tone: 'accent' });
    expect(m.modeText).toBe('mode: balanced');
  });
  it('spend is a measured figure, with the cache hit and warm state', () => {
    expect(text(m, 'Расход')).toBe('$6.71 факт   кэш hit 94% · ● warm 58m');
  });
  it('model mix bars are per tier, scaled to the busiest', () => {
    expect(text(m, 'Модели')).toBe('opus ▇▇▇▇░░░░░░ 31   sonnet ▇▇▇▇▇▇▇▇▇▇ 84   haiku ▇▇▇░░░░░░░ 27');
  });
  it('savings are only agento\'s mechanisms and are marked as an estimate', () => {
    expect(text(m, 'Экономия')).toBe('≈ $2.12  (субагенты $1.30 · подсказки $0.82)   оценка');
    const tones = m.rows.find((r) => r.label === 'Экономия')?.segs.map((s) => s.tone);
    expect(tones).toEqual(['success', 'dim', 'warning']);
  });
  it('hints and loop events', () => {
    expect(text(m, 'Подсказки')).toBe('4 показано · 2 принято · 1 «не предлагать»');
    expect(text(m, 'Буксование')).toBe('1 (auth.spec падает 3 раза)');
  });
  it('footer: buttons name the current settings; range options', () => {
    expect(m.buttons).toEqual({ mode: 'Режим', orchestrate: 'Оркестр: выкл', autopilot: 'Автопилот: выкл' });
    expect(m.rangeOptions.map((o) => o.value)).toEqual(['session', 'today', '7d', 'all']);
  });

  it('a cold cache, no hits yet', () => {
    const c = buildPanel(data({ cache: { ...cache, lastAt: NOW - 2 * 3_600_000 }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, steps: 0, byModel: {}, hints: { shown: 0, accepted: 0, dismissed: 0, auto: 0 }, loopSignals: 0, lastSignal: null, saved: { spawnRouting: 0, suggestions: 0, handoff: 0, autopilot: 0 } }), 'en');
    expect(text(c, 'Spend')).toBe('$6.71 measured · ○ cold');
    expect(text(c, 'Models')).toBe('no steps yet');
    expect(text(c, 'Savings')).toBe('nothing to credit yet');
    expect(text(c, 'Loops')).toBe('none');
  });

  it('a subscriber sees the weekly limit; savings in percent when a calibration exists, else dollars', () => {
    const sub = buildPanel(data({ isSubscription: true, sevenDayPct: 63.4, pctPerUsd: 4 }), 'ru');
    expect(text(sub, 'Расход')).toContain('API-экв.');
    expect(text(sub, 'Расход')).toContain('7д 63%');
    expect(text(sub, 'Экономия')).toContain('≈ 8.5% недельного лимита');
    const nocal = buildPanel(data({ isSubscription: true, sevenDayPct: 10, pctPerUsd: null }), 'ru');
    expect(text(nocal, 'Экономия')).toContain('≈ $2.12');
  });

  it('autopilot and handoff mechanisms are named; handoff shows executor against planner context', () => {
    const h = buildPanel(data({ saved: { spawnRouting: 0, suggestions: 0.1, handoff: 0.4, autopilot: 0.2 }, hints: { shown: 3, accepted: 1, dismissed: 0, auto: 2 }, handoff: { ts: NOW, planPath: '.agento/plans/p.md', plannerTokens: 142_000, executorTokens: 9_000 } }), 'ru');
    expect(text(h, 'Экономия')).toContain('подсказки $0.10 · автопилот $0.20 · handoff $0.40');
    expect(text(h, 'Подсказки')).toContain('2 авто');
    expect(text(h, 'Handoff')).toBe('контекст исполнителя 9k токенов вместо 142k   .agento/plans/p.md');
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
    expect(f.saved).toEqual({ spawnRouting: 1, suggestions: 0.2, handoff: 0, autopilot: 0.4 });
    expect(f.hints).toEqual({ shown: 4, accepted: 2, dismissed: 0, auto: 2 });
    expect(f.loopSignals).toBe(2);
  });
});
