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

  test('the session itself is never moved: no /model or /effort (they would become the default of every new session)', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    r.steps.length = 0;
    await prompt($, LIGHT);
    await turn($, 't2', () => request($, r));
    expect(r.commands).toEqual([]);
    expect(r.model).toBe(OPUS);
    // The next turn of the same task: still the task's setup, from its first request to its last.
    await turn($, 't3', () => request($, r, 0));
    expect(r.steps).toEqual([{ model: SONNET, effort: 'medium', agentId: undefined }, { model: SONNET, effort: 'medium', agentId: undefined }]);
    expect(r.commands).toEqual([]);
    // The next clean point decides again, from the user's own setup.
    await r.clock.advance(6 * 60_000);
    await prompt($, 'Спроектируй архитектуру нового сервиса уведомлений');
    expect(r.task?.override ?? null).toBeNull();
    await request($, r, 0);
    expect(r.steps.at(-1)).toEqual({ model: OPUS, effort: 'high', agentId: undefined });
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

  test('[Back to opus·high] after the turn: still only the override goes, no command is run', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    await prompt($, LIGHT);
    await turn($, 't2', () => request($, r));
    r.steps.length = 0;
    const ui = await mountBand($);
    await ui.press({ key: 'undo' });
    expect(r.commands).toEqual([]);
    expect(r.task?.override).toBeNull();
    expect(r.ledger?.credit).toBeNull();
    await request($, r);
    expect(r.steps[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined });
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

  test('on by default: the light task runs cheaper, and the turn ends with a receipt that keeps the undo', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('AP');
    await turn($, 't1', () => request($, r));
    expect(r.commands).toEqual([]);
    expect(r.steps[0]?.model).not.toBe(OPUS);
    expect(r.banner?.scenario).toBe('RC');
    expect(r.banner?.title).toMatch(/^This task cost \$\d+\.\d\d$/);
    expect(r.banner?.reason).toMatch(/^agento saved ≈\$\d+\.\d\d: autopilot picked a cheaper model$/);
    expect(r.banner?.actions.map((x) => x.key)).toEqual(['undo', 'details']);
  });

  test('autopilot off: suggestions only, no request is ever rewritten', { options: { autopilot: 'off' } }, async ($, on) => {
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

  test('every request of the task is on the cheaper model — never half and half', AUTO, async ($, on) => {
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

  test('a reload of the module (a setting changed, /reload-plugins) runs session.start again: the task goes on as it was', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, FIRST);
    r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
    await request($, r);
    await start($);
    r.steps.length = 0;
    // Not a first prompt: the conversation is warm, the model stays.
    await prompt($, LIGHT);
    expect(r.task?.override ?? null).toBeNull();
    expect(r.banner?.scenario).not.toBe('AP');
    await request($, r, 1);
    expect(r.steps[0]?.model).toBe(OPUS);
  });

  test('a reload keeps the override of the task in progress', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await start($);
    expect(r.task?.override?.model).toBe('sonnet');
    await request($, r);
    expect(r.steps[0]?.model).toBe(SONNET);
  });

  test('a resumed or continued conversation (claude -c): its first prompt here is no clean point', AUTO, async ($, on) => {
    const r = rig(on, { turns: 4 });
    await start($);
    await prompt($, LIGHT);
    expect(r.task?.override ?? null).toBeNull();
    expect(r.toasts).toEqual([]);
    await request($, r);
    expect(r.steps[0]?.model).toBe(OPUS);
  });

  test('/resume in the session: the conversation that takes its place gets no autopilot on its first prompt', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    await $.session.end({ reason: 'resume', sessionId: 's', resume: {} } as never);
    r.steps.length = 0;
    await prompt($, LIGHT);
    expect(r.task?.override ?? null).toBeNull();
    await request($, r);
    expect(r.steps[0]?.model).toBe(OPUS);
  });

  test('a compaction mid-turn and a prompt typed into the running turn change nothing under it (P1)', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await $.turn.start({ text: LIGHT, turnId: 't1' } as never);
    await request($, r, 0);
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never);
    expect(r.task?.override?.model).toBe('sonnet');
    await $.prompt.submit({ text: 'Спроектируй заодно архитектуру кэша', wait: false, origin: { kind: 'composer' }, turnId: 't1' } as never);
    expect(r.task?.override?.model).toBe('sonnet');
    expect(r.banner?.scenario).toBe('AP');
    await request($, r, 1);
    expect(r.steps.map((s) => s.model)).toEqual([SONNET, SONNET]);
    // The next prompt of its own after the compaction is the clean point, and decides again.
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never);
    await prompt($, 'Спроектируй архитектуру распределённого кэша');
    expect(r.task?.override ?? null).toBeNull();
  });

  test('/agento new on a warm conversation keeps the setup: dropping it would move the conversation (P1)', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
    await request($, r);
    await slash($, 'agento', 'new');
    await prompt($, FIRST);
    expect(r.task?.override?.model).toBe('sonnet');
    await request($, r, 1);
    expect(r.steps.at(-1)?.model).toBe(SONNET);
  });

  test('an /effort the person types drops only the effort half', AUTO, async ($, on) => {
    const r = rig(on);
    await idleOnOpus($, r);
    await prompt($, LIGHT);
    await slash($, 'effort', 'high');
    expect(r.task?.override).toMatchObject({ model: 'sonnet' });
    expect(r.task?.override?.effort).toBeUndefined();
    r.steps.length = 0;
    await request($, r, 0, 'high');
    expect(r.steps[0]).toEqual({ model: SONNET, effort: 'high', agentId: undefined });
  });

  test('a model the person picked another way (not /model), or the engine fell back to, is not rewritten', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, LIGHT);
    await step($, { model: 'claude-fable-5-1', effort: 'high' });
    expect(r.steps[0]).toEqual({ model: 'claude-fable-5-1', effort: 'high', agentId: undefined });
  });

  test('a slash command is no prompt to judge a task by', AUTO, async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, '/rename typo-fix');
    expect(r.task?.override ?? null).toBeNull();
    expect(r.toasts).toEqual([]);
    // The real first prompt still is the clean point.
    await prompt($, LIGHT);
    expect(r.task?.override?.model).toBe('sonnet');
  });

  test('a store that never answers holds a model request back by seconds at most (P5)', AUTO, async ($, on) => {
    const r = rig(on, { hangOn: ['store.set'] });
    await start($);
    let done = false;
    const p = request($, r).then((x) => {
      done = true;
      return x;
    });
    for (let i = 0; i < 10 && !done; i += 1) await r.clock.advance(1000);
    const res = await p;
    expect(res.usage?.model).toBe(OPUS);
    expect(done).toBe(true);
  });
});
