import { describe, expect, test, type Engine } from 'claude-code/testing';
import { OPUS, SONNET, prompt, rig, slash, step, turn, type Rig } from './rig.ts';

const LIGHT = 'Исправь опечатку в README';
const HEAVY = 'Спроектируй архитектуру распределённой очереди задач с миграцией старых данных';
const FIRST = 'Добавь тесты для парсера конфигурации и обработку ошибок';
const AUTO = { options: { autopilot: 'clean-points' } } as const;

const start = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
const mountBand = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'agento', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { bodyRows: 12 }, view: {} } as never });

// A main request as the engine sends it: on the session's own model and effort.
const request = ($: Engine, r: Rig, index = 0, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high') => step($, { model: r.model, effort, index });

// A task under way on opus·high, then a pause past the cache TTL: the next prompt is a clean point.
async function idleOnOpus($: Engine, r: Rig): Promise<void> {
  await start($);
  await prompt($, FIRST);
  r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
  await request($, r);
  await r.clock.advance(6 * 60_000);
}

describe('autopilot: clean-points', () => {
  test('first prompt of a session: decided at the prompt, applied from the first request; a toast and a notice say so', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    // `$.command.run` is refused inside prompt.submit: nothing is run there, the prompt goes out as typed.
    expect(r.commands).toEqual([]);
    expect(r.submitted).toEqual([{ text: LIGHT, context: undefined }]);
    expect(r.task?.override).toMatchObject({ model: 'sonnet', modelId: SONNET, fromModel: OPUS, persisted: false });
    expect(r.toasts).toEqual(['agento: sonnet for this task (was opus). Undo: button above the prompt']);
    expect(r.banner?.scenario).toBe('AP');
    expect(r.banner?.actions.map((a) => [a.key, a.label])).toEqual([['undo', 'Back to opus'], ['disable', 'Turn autopilot off'], ['ok', 'OK']]);
    expect(r.banner?.estimate).toBe('≈ −$0.18 on a task like this · estimate');
    expect(r.ledger?.hints).toMatchObject({ shown: 1, auto: 1, accepted: 0 });
    // The task's first request goes out on sonnet.
    await $.turn.start({ text: LIGHT, turnId: 't1' } as never);
    await request($, r);
    expect(r.steps).toEqual([{ model: SONNET, effort: 'high', agentId: undefined }]);
  });

  test('after a pause past the TTL, model and effort both come down on the task\'s requests', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    r.steps.length = 0;
    await prompt($, LIGHT);
    expect(r.toasts[0]).toBe('agento: sonnet·medium for this task (was opus·high). Undo: button above the prompt');
    await request($, r, 0);
    await request($, r, 1);
    expect(r.steps).toEqual([{ model: SONNET, effort: 'medium', agentId: undefined }, { model: SONNET, effort: 'medium', agentId: undefined }]);
  });

  test('once the turn is complete, /model and /effort make it the session\'s own; later requests are left alone', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    r.steps.length = 0;
    await prompt($, LIGHT);
    await turn($, 't2', () => request($, r));
    expect(r.commands).toEqual([{ command: 'model', args: 'sonnet' }, { command: 'effort', args: 'medium' }]);
    expect(r.model).toBe(SONNET);
    expect(r.task?.override?.persisted).toBe(true);
    // The next turn of the same task: the session is on sonnet, nothing is rewritten, nothing is re-run.
    await request($, r, 0, 'medium');
    expect(r.steps[1]).toEqual({ model: SONNET, effort: 'medium', agentId: undefined });
    await turn($, 't3', () => request($, r));
    expect(r.commands).toHaveLength(2);
  });

  test('the ledger records the mechanism: steps on the cheaper model are credited to autopilot, as an estimate', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    await prompt($, LIGHT);
    expect(r.ledger?.credit).toMatchObject({ mechanism: 'autopilot', fromModel: OPUS, model: 'sonnet' });
    r.usage = { in: 0, out: 1500, read: 100_000, write: 3000 };
    await request($, r, 1);
    const s = r.ledger?.recent[r.ledger.recent.length - 1];
    expect(s?.model).toBe(SONNET);
    expect(s?.mechanism).toBe('autopilot');
    expect(Math.abs((s?.savedEstimate ?? 0) - 0.0225)).toBeLessThan(1e-9);
    expect(Math.abs((r.ledger?.savedEstimate.autopilot ?? 0) - 0.0225)).toBeLessThan(1e-9);
    expect(r.ledger?.savedEstimate.suggestions).toBe(0);
    const day = r.store.get([...r.store.keys()].find((k) => k.startsWith('day:')) as string) as { autopilotActions: number; savedEstimate: { autopilot: number } };
    expect(day.autopilotActions).toBe(1);
    expect(day.savedEstimate.autopilot).toBeGreaterThan(0.02);
  });

  test('[Back to opus·high] before the turn ends: the override is dropped, no command is needed', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    r.steps.length = 0;
    await prompt($, LIGHT);
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountBand($, surface);
      expect((await ui.find({ key: 'undo' }))?.props.label).toBe('Back to opus·high');
      await ui.unmount();
    }
    const ui = await mountBand($);
    await ui.press({ key: 'undo' });
    expect(r.commands).toEqual([]);
    expect(r.task?.override).toBeNull();
    expect(r.ledger?.credit).toBeNull();
    expect(r.banner).toBeNull();
    await request($, r);
    expect(r.steps[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined });
  });

  test('[Back to opus·high] after the turn: /model and /effort with what the user had', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    await prompt($, LIGHT);
    await turn($, 't2', () => request($, r));
    r.commands.length = 0;
    const ui = await mountBand($);
    await ui.press({ key: 'undo' });
    expect(r.commands).toEqual([{ command: 'model', args: OPUS }, { command: 'effort', args: 'high' }]);
    expect(r.model).toBe(OPUS);
    expect(r.task?.override).toBeNull();
    expect(r.ledger?.credit).toBeNull();
  });

  test('[Turn autopilot off] switches the setting and leaves the task as it is', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    const ui = await mountBand($);
    await ui.press({ key: 'disable' });
    expect(r.configs).toEqual([{ key: 'agento.autopilot', value: 'off' }]);
    expect(r.banner).toBeNull();
    expect(r.task?.override?.model).toBe('sonnet');
  });

  test('a /model the person types ends it: their choice is theirs', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.task?.override).not.toBeNull();
    await slash($, 'model', 'opus');
    expect(r.task?.override).toBeNull();
    await request($, r);
    expect(r.steps[0]?.model).toBe(OPUS);
  });

  test('default is off (P1): suggestions only, no request is ever rewritten', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await turn($, 't1', () => request($, r));
    expect(r.commands).toEqual([]);
    expect(r.steps[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined });
    expect(r.banner?.scenario).toBe('S1');
    expect(r.task?.override).toBeNull();
  });

  test('never mid-task: a light prompt in a warm context starts no override', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, FIRST);
    r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
    await request($, r);
    expect(r.task?.override ?? null).toBeNull();
    r.steps.length = 0;
    await prompt($, LIGHT);
    expect(r.task?.override ?? null).toBeNull();
    await request($, r, 1);
    expect(r.steps[0]?.model).toBe(OPUS);
  });

  test('every request of the task is on the cheaper model until it is persisted — never half and half', AUTO, async ($, on) => {
    const r = rig(on, { throwOn: ['command.run:model'] });
    await start($);
    await prompt($, LIGHT);
    await turn($, 't1', async () => {
      await request($, r, 0);
      await request($, r, 1);
    });
    expect(r.task?.override?.persisted).toBe(false);
    // The next turn of the same task: still rewritten, because the session was not moved.
    await turn($, 't2', () => request($, r));
    expect(r.steps.map((s) => s.model)).toEqual([SONNET, SONNET, SONNET]);
    // A new task is a new decision.
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    expect(r.task?.override).toBeNull();
    await request($, r);
    expect(r.steps[3]?.model).toBe(OPUS);
  });

  test('subagent requests are never rewritten', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await step($, { model: OPUS, agentId: 'a1', effort: undefined, index: 1 });
    expect(r.steps[0]).toEqual({ model: OPUS, effort: undefined, agentId: 'a1' });
  });

  test('a subagent finishing is not the main turn finishing', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await $.turn.complete({ turnId: 'sub', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never);
    expect(r.commands).toEqual([]);
    expect(r.task?.override?.persisted).toBe(false);
  });

  test('after /clear and after a compaction it decides again', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, FIRST);
    r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
    await request($, r);
    expect(r.task?.override ?? null).toBeNull();
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, LIGHT);
    expect(r.task?.override?.model).toBe('sonnet');
  });

  test('never above the user\'s choice (P3): a sonnet user with a heavy task is offered a conversation, not changed', AUTO, async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, HEAVY);
    expect(r.task?.override ?? null).toBeNull();
    await request($, r);
    expect(r.steps[0]?.model).toBe(SONNET);
    expect(r.banner?.scenario).toBe('S2a');
  });

  test('already on the cheapest setup that fits: nothing to do', AUTO, async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, LIGHT);
    expect(r.task?.override ?? null).toBeNull();
    expect(r.banner).toBeNull();
  });

  test('below the confidence threshold it holds back', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, 'Сделай что-нибудь с кодом в проекте, как считаешь нужным');
    expect(r.task?.override ?? null).toBeNull();
    expect(r.banner).toBeNull();
  });

  test('quality never changes anything, autopilot or not', { options: { autopilot: 'clean-points', mode: 'quality' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await turn($, 't1', () => request($, r));
    expect(r.task?.override ?? null).toBeNull();
    expect(r.steps[0]?.model).toBe(OPUS);
    expect(r.commands).toEqual([]);
  });

  test('suggestions off do not stop autopilot', { options: { autopilot: 'clean-points', suggestions: 'off' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.task?.override?.model).toBe('sonnet');
  });

  test('a model it cannot name an id for (a gateway) is not rewritten: the user gets the ordinary suggestion', AUTO, async ($, on) => {
    const r = rig(on, { model: 'us.anthropic.claude-opus-5-5-v1:0' });
    await start($);
    await prompt($, LIGHT);
    expect(r.task?.override ?? null).toBeNull();
    expect(r.ledger?.credit).toBeNull();
    expect(r.ledger?.hints.auto).toBe(0);
    expect(r.banner?.scenario === 'S1' || r.banner === null).toBe(true);
  });

  test('a failing session.model read: the prompt goes through unchanged', AUTO, async ($, on) => {
    const r = rig(on, { throwOn: ['session.model'] });
    await start($);
    await prompt($, LIGHT);
    expect(r.submitted).toEqual([{ text: LIGHT, context: undefined }]);
    expect(r.task?.override ?? null).toBeNull();
  });
});
