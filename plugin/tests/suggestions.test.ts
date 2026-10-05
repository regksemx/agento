import { describe, expect, test, type Engine } from 'claude-code/testing';
import { OPUS, SONNET, prompt, rig, slash, step, type Rig } from './rig.ts';

const LIGHT = 'Исправь опечатку в README';
const HEAVY = 'Спроектируй архитектуру распределённой очереди задач с миграцией старых данных';
const FABLE = 'claude-fable-5-1';
const CWD = '/work/app';

const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { bodyRows: 12 }, view: {} } as never;
const SURFACES = ['terminal', 'desktop'] as const;

const start = ($: Engine, cwd = CWD) => $.session.start({ cwd, surface: 'terminal', isInteractive: true });
const mountBand = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal') => $.ui.mount({ plugin: 'agento', surface, component: 'AbovePrompt', props: BAND });

// A task already under way: the first prompt sent, one request answered on a small context.
const FIRST = 'Добавь тесты для парсера конфигурации и обработку ошибок';
async function begin($: Engine, r: Rig, read = 20_000): Promise<void> {
  await start($);
  await prompt($, FIRST);
  r.usage = { in: 0, out: 1500, read, write: 3000 };
  await step($);
}

// A conversation of `read` cached tokens on opus, last touched now.
async function warmUp($: Engine, r: Rig, read: number, model = OPUS): Promise<void> {
  r.usage = { in: 0, out: 1500, read, write: 3000, model };
  await step($, { model });
}

describe('T18: S1 at a clean point', () => {
  test('first prompt, light task on opus: a banner with reason, estimate and the four buttons', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    const b = r.banner;
    expect(b?.scenario).toBe('S1');
    expect(b?.title).toBe('Looks like a light task');
    expect(b?.reason).toContain('sonnet');
    expect(b?.reason).toContain('light-task words');
    // No history yet: spec §1's reference step, 8 steps for a light task: 8 × $0.0225.
    expect(b?.estimate).toBe('≈ −$0.18 on a task like this · estimate');
    expect(b?.actions.map((a) => a.key)).toEqual(['model', 'keep', 'never']);
    expect(b?.data).toMatchObject({ model: 'sonnet', fromModel: OPUS });
    expect(r.ledger?.hints.shown).toBe(1);
  });

  test('the prompt itself is never touched, held back or submitted twice (P1, P4)', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.submitted).toEqual([{ text: LIGHT, context: undefined }]);
    expect(r.commands).toEqual([]);
    expect(r.fills).toEqual([]);
  });

  test('[Sonnet] runs /model sonnet and only that; the change is credited afterwards as an estimate', async ($, on) => {
    const r = rig(on);
    await start($);
    await begin($, r);
    await r.clock.advance(6 * 60_000);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
    const ui = await mountBand($);
    await ui.press({ key: 'model' });
    expect(r.commands).toEqual([{ command: 'model', args: 'sonnet' }]);
    // The effort button is still there for the other half of the verdict.
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['effort', 'keep', 'never']);
    await ui.press({ key: 'keep' });
    expect(r.banner).toBeNull();
    expect(r.ledger?.hints).toMatchObject({ shown: 1, accepted: 1 });
    expect(r.ledger?.credit).toMatchObject({ mechanism: 'suggestion-accepted', fromModel: OPUS, model: 'sonnet' });
    r.usage.model = SONNET;
    await step($, { model: SONNET, effort: 'medium', index: 1 });
    const s = r.ledger?.recent[r.ledger.recent.length - 1];
    expect(s?.mechanism).toBe('suggestion-accepted');
    expect(Math.abs((s?.savedEstimate ?? 0) - 0.0225)).toBeLessThan(1e-9);
    expect(Math.abs((r.ledger?.savedEstimate.suggestions ?? 0) - 0.0225)).toBeLessThan(1e-9);
  });

  test('model and effort are separate buttons; the other one stays after the first is pressed', async ($, on) => {
    const r = rig(on);
    await begin($, r);
    await step($, { effort: 'max', index: 1 });
    await r.clock.advance(6 * 60_000);
    await prompt($, LIGHT);
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['model', 'effort', 'keep', 'never']);
    expect(r.banner?.actions[1]?.label).toBe('Effort medium');
    const ui = await mountBand($);
    await ui.press({ key: 'effort' });
    expect(r.commands).toEqual([{ command: 'effort', args: 'medium' }]);
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['model', 'keep', 'never']);
    await ui.press({ key: 'model' });
    expect(r.commands.map((c) => c.command)).toEqual(['effort', 'model']);
    expect(r.banner).toBeNull();
  });

  test('S6: effort alone on a light task (sonnet·max)', async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, FIRST);
    r.usage.model = SONNET;
    await step($, { model: SONNET, effort: 'xhigh' });
    await r.clock.advance(6 * 60_000);
    await prompt($, LIGHT);
    expect(r.banner?.title).toBe('Effort is higher than this task needs');
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['effort', 'keep', 'never']);
  });

  test('[Keep] closes it, changes nothing, and counts as shown only', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    const ui = await mountBand($);
    await ui.press({ key: 'keep' });
    expect(r.banner).toBeNull();
    expect(r.commands).toEqual([]);
    expect(r.ledger?.hints).toMatchObject({ shown: 1, accepted: 0, dismissed: 0 });
  });

  test('"don\'t suggest" is kept per scenario and directory', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    const ui = await mountBand($);
    await ui.press({ key: 'never' });
    expect(r.store.get(`dismiss:S1:${CWD}`)).toBe(true);
    expect(r.ledger?.hints.dismissed).toBe(1);
    expect(r.banner).toBeNull();
    // Next clean point in the same directory: silent.
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
  });

  test('another directory is not silenced', async ($, on) => {
    const r = rig(on, { store: { 'dismiss:S1:/other': true } });
    await start($);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
  });

  test('a dismissed scenario stays dismissed after a restart (it lives in $.store)', async ($, on) => {
    const r = rig(on, { store: { [`dismiss:S1:${CWD}`]: true } });
    await start($);
    await prompt($, LIGHT);
    expect(r.banner ?? null).toBeNull();
    expect(r.ledger?.hints.shown).toBe(0);
  });

  test('works on the terminal and on the desktop surface', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface);
      expect((await ui.find({ type: 'Text', text: 'Looks like a light task' }))?.type).toBe('Text');
      expect((await ui.find({ type: 'Text', text: /≈ −\$0\.18/ }))).toBeDefined();
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(3);
      expect((await ui.find({ key: 'model' }))?.props.label).toBe('Sonnet');
      await ui.unmount();
    }
  });

  test('a survey holds the band: agento yields, the banner waits', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    const ui = await $.ui.mount({ plugin: 'agento', surface: 'terminal', component: 'AbovePrompt', props: { ...(BAND as object), hasSurvey: true } as never });
    expect(await ui.find({ key: 'model' })).toBeUndefined();
    expect(r.banner?.scenario).toBe('S1');
  });
});

describe('T18: where S1 may appear', () => {
  test('mid-task (warm cache) no model suggestion is made, even for a light prompt', async ($, on) => {
    const r = rig(on);
    await begin($, r);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
    expect(r.commands).toEqual([]);
  });

  test('after the TTL (5m on an API key) it is a clean point again', async ($, on) => {
    const r = rig(on, { auth: 'api-key' });
    await begin($, r);
    await r.clock.advance(4 * 60_000);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
    await r.clock.advance(2 * 60_000);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
  });

  test('a subscriber\'s 1h cache is warm at 20 minutes', async ($, on) => {
    const r = rig(on, { auth: 'bearer' });
    await begin($, r);
    await r.clock.advance(20 * 60_000);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
    await r.clock.advance(41 * 60_000);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
  });

  test('after /clear', async ($, on) => {
    const r = rig(on);
    await begin($, r);
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
  });

  test('after a compaction', async ($, on) => {
    const r = rig(on);
    await begin($, r);
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never);
    expect(r.ledger?.lineages.main).toBeUndefined();
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
  });

  test('a vetoed compaction is no clean point', async ($, on) => {
    const r = rig(on, { compactSkip: true });
    await begin($, r);
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
  });

  test('`/agento new` makes the next prompt a task start', async ($, on) => {
    const r = rig(on);
    await begin($, r);
    const res = await slash($, 'agento', 'new');
    expect(res.text).toContain('new task');
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
  });

  test('not for a model that is already cheap enough', async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
  });

  test('not for a model it cannot price', async ($, on) => {
    const r = rig(on, { model: 'gateway-model' });
    await start($);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
  });

  test('prompts that are not the person\'s (a task notification, a plugin) are left alone', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT, { kind: 'task-notification' });
    expect(r.banner ?? null).toBeNull();
    expect(r.task?.prompts ?? 0).toBe(0);
    await prompt($, LIGHT, { kind: 'plugin', name: 'other' } as never);
    expect(r.banner ?? null).toBeNull();
    expect(r.submitted).toHaveLength(2);
  });

  test('at most one S1 per task', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    const ui = await mountBand($);
    await ui.press({ key: 'keep' });
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
  });
});

describe('T18: thresholds and modes', () => {
  const HEAVY_ON_FABLE = { model: FABLE };

  test('balanced needs 0.65: a heavy verdict (0.6) on fable is not suggested', async ($, on) => {
    const r = rig(on, HEAVY_ON_FABLE);
    await start($);
    await prompt($, HEAVY);
    expect(r.banner).toBeNull();
  });

  test('eco needs 0.55: the same prompt gets S1 to opus', { options: { mode: 'eco' } }, async ($, on) => {
    const r = rig(on, HEAVY_ON_FABLE);
    await start($);
    await prompt($, HEAVY);
    expect(r.banner?.scenario).toBe('S1');
    expect(r.banner?.data.model).toBe('opus');
  });

  test('quality suggests no model, ever', { options: { mode: 'quality' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
    expect(r.commands).toEqual([]);
  });

  test('suggestions off: no banners at all', { options: { suggestions: 'off' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.banner).toBeNull();
    expect(r.ledger?.hints.shown).toBe(0);
  });

  test('off: nothing is read, shown or written', { options: { mode: 'off' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.banner).toBeUndefined();
    expect(r.task).toBeUndefined();
    expect(r.submitted).toEqual([{ text: LIGHT, context: undefined }]);
    // /clear, a compaction, a plan, a turn, a /model: none of it is read or written either.
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never);
    r.results.ExitPlanMode = { plan: '# p' };
    await $.tool.call({ tool: 'ExitPlanMode' } as never);
    await slash($, 'model', 'sonnet');
    await $.turn.start({ text: 'x', turnId: 't1' } as never);
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never);
    expect(r.task).toBeUndefined();
    expect(r.banner).toBeUndefined();
    expect(r.ledger).toBeUndefined();
    expect(r.commands).toEqual([{ command: 'model', args: 'sonnet' }]);
  });
});

describe('T18: estimates', () => {
  test('from the average of this user\'s finished tasks of the class, once there are enough', async ($, on) => {
    const r = rig(on, { store: { 'cls:light': { byTier: { opus: { tasks: 4, cost: 3.2, steps: 40 } } } } });
    await start($);
    await prompt($, LIGHT);
    // avg $0.80 on opus × (0.0225 / 0.065)
    expect(r.banner?.estimate).toBe('≈ −$0.28 on a task like this · estimate');
  });

  test('both tiers known: the difference of their averages, said to be from the user\'s tasks', async ($, on) => {
    const r = rig(on, { store: { 'cls:light': { byTier: { opus: { tasks: 4, cost: 3.2, steps: 40 }, sonnet: { tasks: 3, cost: 1.5, steps: 24 } } } } });
    await start($);
    await prompt($, LIGHT);
    expect(r.banner?.estimate).toBe('≈ −$0.30 on a task like this · estimate from your tasks');
  });

  test('a subscriber with a calibration: percent of the weekly limit', async ($, on) => {
    const windows = [{ resetsAt: 'w1', usd: 6, points: [1, 2, 3, 4, 5, 6].map((n) => ({ usd: n, pct: 10 + 2 * n })) }];
    const r = rig(on, { auth: 'bearer', store: { calibration: { windows } } });
    await start($);
    await prompt($, LIGHT);
    // $0.18 × 2 %/$ = 0.36 %
    expect(r.banner?.estimate).toBe('≈ −0.4% of the weekly limit on a task like this · estimate');
  });

  test('a subscriber without one: API-equivalent dollars, said so', async ($, on) => {
    const r = rig(on, { auth: 'bearer' });
    await start($);
    await prompt($, LIGHT);
    expect(r.banner?.estimate).toBe('≈ −$0.18 API-equivalent on a task like this · estimate');
  });

  test('a task\'s cost joins the per-class average when the next task starts', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await step($);
    await step($, { index: 1 });
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    const stats = r.store.get('cls:light') as { byTier: { opus: { tasks: number; cost: number; steps: number } } };
    expect(stats.byTier.opus.tasks).toBe(1);
    expect(stats.byTier.opus.steps).toBe(2);
    expect(Math.abs(stats.byTier.opus.cost - 0.13)).toBeLessThan(1e-9);
  });

  test('the calibration is fed by a subscriber\'s steps', async ($, on) => {
    const r = rig(on, { auth: 'bearer', rateLimits: [{ kind: 'seven_day', percentUsed: 12, resetsAt: '2026-10-12T00:00:00Z' }] });
    await step($);
    r.usage = { in: 0, out: 1500, read: 100_000, write: 3000 };
    const cal = r.store.get('calibration') as { windows: Array<{ resetsAt: string; usd: number; points: unknown[] }> };
    expect(cal.windows[0]?.resetsAt).toBe('2026-10-12T00:00:00Z');
    expect(Math.abs((cal.windows[0]?.usd ?? 0) - 0.065)).toBeLessThan(1e-9);
    expect(cal.windows[0]?.points).toEqual([{ usd: 0.065, pct: 12 }]);
  });
});

describe('T18: S4, a new topic in a long warm context', () => {
  const OLD = 'Поправь парсер конфигурации YAML и добавь валидацию схемы';
  const NEW = 'Напиши миграцию базы данных для таблицы заказов и индексы';

  async function longContext($: Engine, r: Rig): Promise<void> {
    await start($);
    await prompt($, OLD);
    await warmUp($, r, 120_000);
  }

  test('S4, not S1 — even though the prompt is light-looking and the model is opus', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await prompt($, NEW);
    const b = r.banner;
    expect(b?.scenario).toBe('S4');
    expect(b?.title).toBe('New topic in a long context');
    expect(b?.reason).toContain('123k');
    // 123k × $0.2/M on opus 5.5.
    expect(b?.reason).toContain('$0.02/step');
    expect(b?.estimate).toMatch(/^≈ −\$0\.\d\d on a task like this · estimate$/);
    expect(b?.actions.map((a) => a.key)).toEqual(['clear', 'compact', 'keep', 'never']);
    expect(r.commands).toEqual([]);
  });

  test('a light prompt in the same warm context never gets S1', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).not.toBe('S1');
  });

  test('the same topic, or a small context, raises nothing', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await prompt($, `${OLD} и ещё для JSON`);
    expect(r.banner).toBeNull();
  });

  test('a new topic in a small context is not worth a /clear', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, OLD);
    await warmUp($, r, 20_000);
    await prompt($, NEW);
    expect(r.banner).toBeNull();
  });

  test('[/clear] clears and puts the prompt back in the box; it does not send it', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await prompt($, NEW);
    const ui = await mountBand($);
    await ui.press({ key: 'clear' });
    expect(r.commands).toEqual([{ command: 'clear', args: '' }]);
    expect(r.fills.map((f) => f.text)).toEqual([NEW]);
    expect(r.submitted.map((s) => s.text)).toEqual([OLD, NEW]);
    expect(r.ledger?.hints.accepted).toBe(1);
    expect(r.banner).toBeNull();
  });

  test('[Compact] runs /compact with instructions about what to keep', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await prompt($, NEW);
    const ui = await mountBand($);
    await ui.press({ key: 'compact' });
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]?.command).toBe('compact');
    expect(r.commands[0]?.args).toContain('Keep:');
    expect(r.commands[0]?.args).toContain('decisions');
    expect(r.fills[0]?.text).toBe(NEW);
  });

  test('once per task, and "don\'t suggest" silences it for the directory', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await prompt($, NEW);
    expect(r.banner?.scenario).toBe('S4');
    const ui = await mountBand($);
    await ui.press({ key: 'keep' });
    await prompt($, 'Переименуй таблицу заказов и обнови внешние ключи и миграции схемы');
    expect(r.banner).toBeNull();
  });

  test('already dismissed for the directory: never shown', async ($, on) => {
    const r = rig(on, { store: { [`dismiss:S4:${CWD}`]: true } });
    await longContext($, r);
    await prompt($, NEW);
    expect(r.banner ?? null).toBeNull();
  });

  test('"don\'t suggest" is stored for the directory', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await prompt($, NEW);
    const ui = await mountBand($);
    await ui.press({ key: 'never' });
    expect(r.store.get(`dismiss:S4:${CWD}`)).toBe(true);
    expect(r.ledger?.hints.dismissed).toBe(1);
  });

  test('a context over 150k gets it without a topic shift', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, OLD);
    await warmUp($, r, 160_000);
    await prompt($, `${OLD} и ещё для JSON`);
    expect(r.banner?.title).toBe('The context grew to 163k');
  });

  test('`/agento new` on a long warm context offers /clear at once', async ($, on) => {
    const r = rig(on);
    await longContext($, r);
    await slash($, 'agento', 'new');
    expect(r.banner?.scenario).toBe('S4');
    expect(r.banner?.title).toBe('New task in a long context');
  });
});

describe('T18: one banner at a time, S7 > S2 > S1 > S4', () => {
  test('a loop signal takes the band from S1; S1 cannot take it back', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(r.banner?.scenario).toBe('S7');
    // A new clean point: S1 is not shown over S7, which stays until it is dealt with.
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    expect(r.banner).toBeNull();
  });

  test('S7 survives the next prompt; a lower banner is not shown over it', async ($, on) => {
    const r = rig(on);
    await start($);
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(r.banner?.scenario).toBe('S7');
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S7');
    expect(r.ledger?.hints.shown).toBe(1);
  });

  test('S2 outranks S1 and S4 outranks nothing', async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, HEAVY);
    expect(r.banner?.scenario).toBe('S2a');
  });

  test('only one banner is ever drawn', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    const ui = await mountBand($);
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3);
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3);
    expect((await ui.find({ key: 'stop' }))?.props.label).toBe('Stop');
    expect(await ui.find({ key: 'model' })).toBeUndefined();
  });
});

describe('S7 buttons', () => {
  async function stuck($: Engine, r: Rig): Promise<void> {
    await start($);
    r.toolIsError = true;
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npx vitest run auth.spec' });
    r.toolIsError = false;
  }

  test('[Stop] aborts the running turn', async ($, on) => {
    const r = rig(on);
    await stuck($, r);
    await $.turn.start({ text: 'fix it', turnId: 't9' });
    const ui = await mountBand($);
    await ui.press({ key: 'stop' });
    expect(r.aborts).toEqual(['t9']);
    expect(r.banner).toBeNull();
  });

  test('[Stop] with nothing running says so and aborts nothing', async ($, on) => {
    const r = rig(on);
    await stuck($, r);
    await $.turn.start({ text: 'fix it', turnId: 't9' });
    await $.turn.complete({ turnId: 't9', reason: 'end_turn' } as never);
    const ui = await mountBand($);
    await ui.press({ key: 'stop' });
    expect(r.aborts).toEqual([]);
    expect(r.toasts[0]).toBe('Nothing is running right now');
  });

  test('[Hint for the agent] rides the next prompt as context; nothing is submitted for the person', async ($, on) => {
    const r = rig(on);
    await stuck($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'hint' });
    expect(r.toasts[0]).toContain('next message');
    expect(r.submitted).toEqual([]);
    await prompt($, 'ну что там');
    expect(r.submitted).toHaveLength(1);
    expect(r.submitted[0]?.text).toBe('ну что там');
    expect(r.submitted[0]?.context?.[0]).toContain('different approach');
    expect(r.submitted[0]?.context?.[0]).toContain('npx vitest run auth.spec');
    // Once only.
    await prompt($, 'и ещё');
    expect(r.submitted[1]?.context).toBeUndefined();
    expect(r.fills).toEqual([]);
  });

  test('[Continue] just closes it', async ($, on) => {
    const r = rig(on);
    await stuck($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'continue' });
    expect(r.banner).toBeNull();
    expect(r.aborts).toEqual([]);
    await prompt($, 'ок');
    expect(r.submitted[0]?.context).toBeUndefined();
  });

  test('a stuck subagent is named', async ($, on) => {
    const r = rig(on);
    await start($);
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope', agentId: 'a1' } as never);
    expect(r.banner?.reason).toContain('(subagent)');
  });
});

describe('T18: fail-open (P5)', () => {
  test('a failing state write: the prompt goes through unchanged', async ($, on) => {
    const r = rig(on, { throwOn: ['state.set'] });
    await start($);
    await prompt($, LIGHT);
    expect(r.submitted).toEqual([{ text: LIGHT, context: undefined }]);
  });

  test('a failing session.model: still no harm', async ($, on) => {
    const r = rig(on, { throwOn: ['session.model'] });
    await start($);
    await prompt($, LIGHT);
    expect(r.submitted).toHaveLength(1);
  });

  test('a button whose command fails leaves the banner in place and the session as it was', async ($, on) => {
    const r = rig(on, { throwOn: ['command.run:model'] });
    await start($);
    await prompt($, LIGHT);
    const ui = await mountBand($);
    await ui.press({ key: 'model' });
    expect(r.banner?.scenario).toBe('S1');
    expect(r.ledger?.credit).toBeNull();
  });
});
