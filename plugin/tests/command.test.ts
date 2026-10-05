import { describe, expect, test as defaultsTest, type Engine } from 'claude-code/testing';
import { HAIKU, OPUS, SONNET, prompt, rig, slash, step, type Rig } from './rig.ts';
import { manualTest as test } from './rig.ts';

const CWD = '/work/app';
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const;
const THEME_COLORS = new Set(['claude', 'success', 'warning', 'suggestion', 'error']);

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true });
const PANE = { title: 'agento', isFocused: false, bodyColumns: 90, placement: 'inline', scroll: { bodyRows: 20 } } as never;
const mountPane = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ plugin: 'agento', surface, component: 'Pane', props: PANE, requestId: 'agento', viewport: { columns: 100, rows: 30 } });

type Mounted = Awaited<ReturnType<typeof mountPane>>;
const rowText = async (ui: Mounted, label: string): Promise<string> => (await ui.find({ key: `val:${label}` }))?.text ?? '';

// Every color and border color in a drawn tree.
function colors(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (node && typeof node === 'object') {
    const n = node as { props?: Record<string, unknown>; children?: unknown[] };
    for (const k of ['color', 'backgroundColor', 'borderColor']) if (typeof n.props?.[k] === 'string') out.add(n.props[k] as string);
    for (const c of n.children ?? []) colors(c, out);
  }
  return out;
}

// A session with some history: opus main steps, a routed haiku subagent, a hint accepted.
async function busy($: Engine, r: Rig): Promise<void> {
  await start($);
  await prompt($, 'Добавь тесты для парсера конфигурации и обработку ошибок');
  await step($);
  await step($, { index: 1 });
  const res = await $.agent.spawn({ subagentType: 'Explore', prompt: 'find usages of foo', parentModel: OPUS, provider: { plugin: 'engine', tier: 'core' } } as never);
  r.usage.model = HAIKU;
  await step($, { agentId: res.agentId, model: HAIKU, effort: undefined, index: 2 });
  r.usage.model = SONNET;
  await step($, { model: SONNET, effort: 'medium', index: 3 });
}

describe('T21: the /agento command', () => {
  test('is registered at session start — also when agento is off, so it can be turned back on', async ($, on) => {
    const r = rig(on);
    await start($);
    expect(r.registered).toEqual(['agento']);
  });

  test('off still registers it', { options: { mode: 'off' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    expect(r.registered).toEqual(['agento']);
    const res = await slash($, 'agento', 'mode eco');
    expect(r.configs).toEqual([{ key: 'agento.mode', value: 'eco' }]);
    expect(res.text).toBe('mode: eco');
  });

  test('no arguments: the pane opens', async ($, on) => {
    const r = rig(on);
    await start($);
    const res = await slash($, 'agento');
    expect(r.panes).toEqual(['agento']);
    expect(res.text).toBeUndefined();
  });

  test('a pane that does not fit says how to fix it', async ($, on) => {
    const r = rig(on, { narrowPane: true });
    await start($);
    const res = await slash($, 'agento', '');
    expect(res.text).toBe('The panel does not fit: widen the terminal and run /agento again');
    expect(r.panes).toEqual(['agento']);
  });

  test('mode, autopilot and orchestrate go through the settings (they reload agento with the new options)', async ($, on) => {
    const r = rig(on);
    await start($);
    expect((await slash($, 'agento', 'mode quality')).text).toBe('mode: quality');
    expect((await slash($, 'agento', 'autopilot clean-points')).text).toBe('autopilot: clean-points');
    expect((await slash($, 'agento', 'orchestrate on')).text).toBe('orchestrate: on — applies from the next session (the system prompt is fixed at start)');
    expect(r.configs).toEqual([
      { key: 'agento.mode', value: 'quality' },
      { key: 'agento.autopilot', value: 'clean-points' },
      { key: 'agento.orchestrate', value: 'on' },
    ]);
  });

  test('orchestrate is explained in russian too', async ($, on) => {
    rig(on, { lang: 'ru_RU.UTF-8' });
    await start($);
    expect((await slash($, 'agento', 'orchestrate on')).text).toBe('orchestrate: on — применится со следующей сессии (system prompt фиксируется при старте)');
  });

  test('anything else gets the usage, and changes nothing', async ($, on) => {
    const r = rig(on);
    await start($);
    for (const bad of ['mode turbo', 'autopilot full', 'orchestrate', 'wat']) {
      const res = await slash($, 'agento', bad);
      expect(res.text).toContain('/agento mode <balanced|eco|quality|off>');
      expect(res.text).toContain('/agento orchestrate <on|off>');
    }
    expect(r.configs).toEqual([]);
  });

  test('`new` is an explicit task start: the next prompt is judged as one', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, 'Добавь тесты для парсера конфигурации и обработку ошибок');
    r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
    await step($);
    await prompt($, 'Исправь опечатку в README');
    expect(r.banner).toBeNull();
    await slash($, 'agento', 'new');
    expect(r.task?.explicitNew).toBe(true);
    await prompt($, 'Исправь опечатку в README');
    expect(r.banner?.scenario).toBe('S1');
    expect(r.task?.explicitNew).toBe(false);
  });
});

describe('T21: the pane, on every surface', () => {
  for (const surface of SURFACES) {
    test(`${surface}: header, the rows of spec §7.7, the footer`, async ($, on) => {
      const r = rig(on);
      await busy($, r);
      const ui = await mountPane($, surface);
      expect((await ui.find({ type: 'Text', text: '◆' }))).toBeDefined();
      expect((await ui.find({ type: 'Text', text: /agento · session 0m/ }))).toBeDefined();
      expect((await ui.find({ key: 'mode' }))).toMatchObject({ props: { label: 'Mode: balanced' } });
      expect((await ui.find({ type: 'Text', text: /^Settings/ }))).toBeDefined();
      for (const label of ['Saved', 'What it did', 'Task', 'Spend', 'Models', 'Cache']) expect(await ui.find({ key: `val:${label}` })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /── Details/ })).toBeDefined();
      // The routed haiku subagent is credited as an estimate, and says so.
      expect(await rowText(ui, 'Saved')).toMatch(/^≈ \$0\.04 {3}estimate$/);
      expect(await rowText(ui, 'What it did')).toMatch(/^subagents: haiku ×1 — ≈\$0\.04$/);
      expect(await rowText(ui, 'Task')).toMatch(/^\$0\.19 · 3 steps/);
      expect(await rowText(ui, 'Spend')).toMatch(/^\$0\.19 measured/);
      expect(await rowText(ui, 'Spend')).toContain('cache hit');
      expect(await rowText(ui, 'Cache')).toContain('● warm');
      expect(await rowText(ui, 'Models')).toBe('opus ▇▇▇▇▇▇▇▇▇▇ 2   sonnet ▇▇▇▇▇░░░░░ 1   haiku ▇▇▇▇▇░░░░░ 1');
      for (const key of ['mode', 'orchestrate', 'autopilot', 'range:session', 'range:today', 'range:7d', 'range:all']) expect(await ui.find({ key })).toBeDefined();
      expect((await ui.find({ key: 'orchestrate' }))?.props.label).toBe('Orchestra: off');
      expect((await ui.find({ key: 'autopilot' }))?.props.label).toBe('Autopilot: off');
      expect((await ui.find({ key: 'mode' }))?.props.label).toBe('Mode: balanced');
      await ui.unmount();
    });
  }

  test('Claude Code look: theme colors only, dim secondary text, the ◆ mark in the accent', async ($, on) => {
    const r = rig(on);
    await busy($, r);
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountPane($, surface);
      const used = colors(await ui.drawn());
      expect([...used].every((c) => THEME_COLORS.has(c))).toBe(true);
      expect((await ui.find({ type: 'Text', text: '◆' }))?.props.color).toBe('claude');
      expect((await ui.findAll({ type: 'Text' })).some((t) => t.props.dimColor === true)).toBe(true);
      await ui.unmount();
    }
  });

  test('hints, loop events and the autopilot count show up', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, 'Исправь опечатку в README');
    const band = await $.ui.mount({ plugin: 'agento', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { bodyRows: 12 }, view: {} } as never });
    await band.press({ key: 'never' });
    r.toolIsError = true;
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npx vitest run auth.spec' });
    const ui = await mountPane($);
    expect(await rowText(ui, 'What it did')).toBe('flagged a stuck agent ×1  (npx vitest run auth.spec)');
  });

  test('a subscriber sees the weekly limit, and savings in percent once a calibration exists', async ($, on) => {
    const windows = [{ resetsAt: 'w1', usd: 6, points: [1, 2, 3, 4, 5, 6].map((n) => ({ usd: n, pct: 10 + 2 * n })) }];
    const r = rig(on, { auth: 'bearer', rateLimits: [{ kind: 'seven_day', percentUsed: 63.4, resetsAt: 'w1' }], store: { calibration: { windows } } });
    await busy($, r);
    const ui = await mountPane($);
    expect(await rowText(ui, 'Spend')).toContain('API-equiv.');
    expect(await rowText(ui, 'Limits')).toContain('63%');
    expect(await rowText(ui, 'Saved')).toMatch(/^≈ \d\.\d+% of the week/);
  });

  test('russian', async ($, on) => {
    const r = rig(on, { lang: 'ru_RU.UTF-8' });
    await busy($, r);
    const ui = await mountPane($);
    expect(await ui.find({ key: 'val:Расход' })).toBeDefined();
    expect(await rowText(ui, 'Сэкономлено')).toContain('оценка');
    expect((await ui.find({ key: 'orchestrate' }))?.props.label).toBe('Оркестр: выкл');
  });

  test('before any step it is empty but honest', async ($, on) => {
    rig(on);
    await start($);
    const ui = await mountPane($);
    expect(await rowText(ui, 'Models')).toBe('no steps yet');
    expect(await rowText(ui, 'Saved')).toBe('nothing to credit yet');
    expect(await rowText(ui, 'What it did')).toBe('nothing yet');
  });

  defaultsTest('defaults: autopilot and orchestra are on', async ($, on) => {
    rig(on);
    await start($);
    const ui = await mountPane($);
    expect((await ui.find({ key: 'autopilot' }))?.props.label).toBe('Autopilot: on');
    expect((await ui.find({ key: 'orchestrate' }))?.props.label).toBe('Orchestra: on');
  });

  test('with agento off the pane still opens', { options: { mode: 'off' } }, async ($, on) => {
    rig(on);
    await start($);
    const ui = await mountPane($);
    expect(await ui.find({ key: 'mode' })).toMatchObject({ props: { label: 'Mode: off' } });
  });
});

describe('T21: the pane\'s buttons', () => {
  test('[Mode] walks balanced → eco → quality → off through the settings', async ($, on) => {
    const r = rig(on);
    await start($);
    const ui = await mountPane($);
    await ui.press({ key: 'mode' });
    await ui.press({ key: 'mode' });
    expect(r.configs).toEqual([{ key: 'agento.mode', value: 'eco' }, { key: 'agento.mode', value: 'quality' }]);
  });

  test('[Orchestra] toggles the setting and says it applies from the next session', async ($, on) => {
    const r = rig(on);
    await start($);
    const ui = await mountPane($);
    expect(await ui.find({ type: 'Text', text: /next session/ })).toBeUndefined();
    await ui.press({ key: 'orchestrate' });
    expect(r.configs).toEqual([{ key: 'agento.orchestrate', value: 'on' }]);
    expect((await ui.find({ key: 'orchestrate' }))?.props.label).toBe('Orchestra: on');
    expect(await ui.find({ type: 'Text', text: /applies from the next session/ })).toBeDefined();
    await ui.press({ key: 'orchestrate' });
    expect(r.configs.at(-1)).toEqual({ key: 'agento.orchestrate', value: 'off' });
  });

  test('[Autopilot] toggles off ↔ clean-points', async ($, on) => {
    const r = rig(on);
    await start($);
    const ui = await mountPane($);
    await ui.press({ key: 'autopilot' });
    expect(r.configs).toEqual([{ key: 'agento.autopilot', value: 'clean-points' }]);
    expect((await ui.find({ key: 'autopilot' }))?.props.label).toBe('Autopilot: on');
  });

  test('range: session / today / 7 days / all time read the day aggregates in $.store', async ($, on) => {
    const day = (steps: number, cost: number) => ({
      steps, cost, baselineCost: cost, tokens: { input: 0, output: 0, cacheRead: 900, cacheWrite: 100 },
      byModel: { [OPUS]: { steps, cost } }, savedEstimate: { spawnRouting: 0.5, suggestions: 0.25, handoff: 0, autopilot: 0 },
      routedSpawns: 1, loopSignals: 2, hintsShown: 3, hintsAccepted: 1, hintsDismissed: 1, autopilotActions: 0,
    });
    const d = (ago: number) => {
      const t = new Date(1_760_000_000_000 - ago * 86_400_000);
      return `day:${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    };
    const r = rig(on, { store: { [d(0)]: day(10, 1), [d(3)]: day(20, 2), [d(40)]: day(30, 4) } });
    void r;
    await start($);
    const ui = await mountPane($);
    expect(await rowText(ui, 'Spend')).toMatch(/^\$0\.00/);
    await ui.press({ key: 'range:today' });
    expect(await ui.find({ type: 'Text', text: /agento · today/ })).toBeDefined();
    expect(await rowText(ui, 'Spend')).toMatch(/^\$1\.00 measured/);
    expect(await rowText(ui, 'Saved')).toContain('$0.75');
    await ui.press({ key: 'range:7d' });
    expect(await ui.find({ type: 'Text', text: /agento · 7 days/ })).toBeDefined();
    expect(await rowText(ui, 'Spend')).toMatch(/^\$3\.00 measured/);
    expect(await rowText(ui, 'What it did')).toBe('subagents on cheaper models — ≈$1.00');
    await ui.press({ key: 'range:all' });
    expect(await ui.find({ type: 'Text', text: /agento · all time/ })).toBeDefined();
    expect(await rowText(ui, 'Spend')).toMatch(/^\$7\.00 measured/);
    expect(await rowText(ui, 'Models')).toBe('opus ▇▇▇▇▇▇▇▇▇▇ 60');
    await ui.press({ key: 'range:session' });
    expect(await ui.find({ type: 'Text', text: /agento · session/ })).toBeDefined();
  });
});
