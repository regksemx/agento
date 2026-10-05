import { describe, expect, test, type Engine } from 'claude-code/testing';
import { OPUS, SONNET, prompt, rig, step, type Rig } from './rig.ts';

const TASK = 'Добавь тесты для парсера конфигурации и обработку ошибок';
const CWD = '/work/app';
const SPAWN_BASE = { parentModel: OPUS, provider: { plugin: 'engine', tier: 'core' } };

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true });
const spawn = ($: Engine, args: Record<string, unknown>) => $.agent.spawn({ ...SPAWN_BASE, ...args } as never);
const mountBand = ($: Engine) =>
  $.ui.mount({ plugin: 'agento', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { bodyRows: 12 }, view: {} } as never });

// One main request, then the tool it asked for.
async function round($: Engine, r: Rig, index: number, tool: Record<string, unknown>): Promise<void> {
  await step($, { model: r.model, effort: 'high', index });
  await $.tool.call(tool as never);
}
const read = (n: number) => ({ tool: 'Read', file_path: `/work/app/f${n}.ts` });
const edit = { tool: 'Edit', file_path: '/work/app/f0.ts', old_string: 'a', new_string: 'b' };

// A small task on opus: three reads of one file, then one mechanical edit, a small cache throughout.
async function smallTask($: Engine, r: Rig): Promise<void> {
  await start($);
  await prompt($, TASK);
  r.usage = { in: 0, out: 500, read: 8000, write: 1000 };
  for (let i = 0; i < 3; i++) await round($, r, i, read(0));
  await round($, r, 3, edit);
}

describe('routing after the first steps of a task', () => {
  test('after four main tool calls one banner appears, once, and the main model is not rewritten', async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    expect(r.banner?.scenario).toBe('S3');
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['model', 'keep', 'never']);
    expect(r.banner?.reason).toContain('After 4 steps');
    expect(r.ledger?.hints.shown).toBe(1);
    // More work in the same task: no second banner.
    for (let i = 4; i < 8; i++) await round($, r, i, read(0));
    expect(r.ledger?.hints.shown).toBe(1);
    // P1: every request went out on the model it was made on, nothing was run, nothing was held for the task.
    expect(r.steps.map((s) => s.model)).toEqual(Array(8).fill(OPUS));
    expect(r.steps.map((s) => s.effort)).toEqual(Array(8).fill('high'));
    expect(r.commands).toEqual([]);
    expect(r.model).toBe(OPUS);
    expect(r.task?.override ?? null).toBeNull();
    expect(r.toasts).toEqual([]);
  });

  test('the verdict is recorded as a route with a trajectory stage; the start record stays as it was', async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    expect(r.ledger?.routes).toHaveLength(2);
    expect(r.ledger?.routes?.[0]?.stage).toBeUndefined();
    expect(r.ledger?.routes?.[1]).toMatchObject({ stage: 'trajectory', classifier: 'trajectory-v1', complexity: 'small', tier: 'sonnet', action: 'S3' });
    expect(r.task?.trajectoryVerdict).toMatchObject({ complexity: 'small', spawnTier: 'sonnet' });
    expect(r.task?.trajectory).toMatchObject({ steps: 4, reads: 3, edits: 1, hasEdit: true });
  });

  test('subagents spawned afterwards are held to the ceiling; before it they were not', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, TASK);
    await spawn($, { subagentType: 'general-purpose', prompt: 'do something' });
    expect(r.spawns[0]?.model).toBeUndefined();
    r.usage = { in: 0, out: 500, read: 8000, write: 1000 };
    for (let i = 0; i < 3; i++) await round($, r, i, read(0));
    await round($, r, 3, edit);
    await spawn($, { subagentType: 'general-purpose', prompt: 'do something' });
    expect(r.spawns[1]?.model).toBe('sonnet');
    // Never above the parent, and an explicit model is the caller's.
    await spawn($, { subagentType: 'general-purpose', prompt: 'do something', parentModel: SONNET });
    expect(r.spawns[2]?.model).toBeUndefined();
    await spawn($, { subagentType: 'general-purpose', prompt: 'do something', model: 'opus' });
    expect(r.spawns[3]?.model).toBe('opus');
  });

  test('a subagent\'s steps and tool calls are not the main thread\'s trajectory', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, TASK);
    r.usage = { in: 0, out: 500, read: 8000, write: 1000 };
    for (let i = 0; i < 6; i++) {
      await step($, { model: r.model, effort: 'high', index: i, agentId: 'a1' });
      await $.tool.call({ ...read(i), agentId: 'a1' } as never);
    }
    expect(r.banner ?? null).toBeNull();
    expect(r.task?.trajectoryVerdict ?? null).toBeNull();
    expect(r.task?.trajectory?.steps ?? 0).toBe(0);
  });

  test('a task that goes badly is large: no banner, no ceiling, nothing changes', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, TASK);
    r.usage = { in: 0, out: 500, read: 8000, write: 1000 };
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await round($, r, i, read(i));
    expect(r.task?.trajectoryVerdict).toMatchObject({ complexity: 'large', spawnTier: null, mainDowngrade: null, handoff: false });
    expect(r.banner?.scenario).not.toBe('S3');
    await spawn($, { subagentType: 'general-purpose', prompt: 'do something' });
    expect(r.spawns[0]?.model).toBeUndefined();
  });

  test('quality mode: nothing is folded, decided or shown', { options: { mode: 'quality' } }, async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    expect(r.banner ?? null).toBeNull();
    expect(r.task?.trajectoryVerdict ?? null).toBeNull();
    await spawn($, { subagentType: 'general-purpose', prompt: 'do something' });
    expect(r.spawns[0]?.model).toBeUndefined();
  });

  test('suggestions off: the verdict still sets the ceiling for subagents, but no banner', { options: { suggestions: 'off' } }, async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    expect(r.banner ?? null).toBeNull();
    await spawn($, { subagentType: 'general-purpose', prompt: 'do something' });
    expect(r.spawns[0]?.model).toBe('sonnet');
  });

  test('a user already on sonnet: no banner and nothing to lower', async ($, on) => {
    const r = rig(on, { model: SONNET });
    await smallTask($, r);
    expect(r.banner ?? null).toBeNull();
    expect(r.task?.trajectoryVerdict).toMatchObject({ complexity: 'small', spawnTier: null, mainDowngrade: null });
  });

  test('a long context explored without an edit: the banner points at the plan, with no model button', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, TASK);
    r.usage = { in: 0, out: 500, read: 118_000, write: 2000 };
    for (let i = 0; i < 4; i++) await round($, r, i, read(i));
    expect(r.banner?.scenario).toBe('S3');
    expect(r.banner?.title).toBe('Exploring is done, the coding is next');
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['keep', 'never']);
    expect(r.commands).toEqual([]);
    expect(r.task?.override ?? null).toBeNull();
  });

  test('S7 keeps the band: the trajectory banner does not replace it', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, TASK);
    r.usage = { in: 0, out: 500, read: 8000, write: 1000 };
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(r.banner?.scenario).toBe('S7');
    r.toolIsError = false;
    for (let i = 0; i < 3; i++) await round($, r, i, read(0));
    await round($, r, 3, edit);
    expect(r.banner?.scenario).toBe('S7');
  });

  test('"don\'t suggest" is kept for the directory; the next task shows nothing', async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'never' });
    expect(r.store.get(`dismiss:S3:${CWD}`)).toBe(true);
    expect(r.banner).toBeNull();
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, TASK);
    for (let i = 0; i < 3; i++) await round($, r, i, read(0));
    await round($, r, 3, edit);
    expect(r.banner ?? null).toBeNull();
    expect(r.task?.trajectoryVerdict).toMatchObject({ complexity: 'small' });
  });

  test('[Keep] closes it and changes nothing', async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'keep' });
    expect(r.banner).toBeNull();
    expect(r.task?.override ?? null).toBeNull();
    expect(r.commands).toEqual([]);
  });

  test('[Sonnet] is the person\'s choice: held for the rest of the task, never a /model', async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'model' });
    expect(r.commands).toEqual([]);
    expect(r.task?.override).toMatchObject({ model: 'sonnet', modelId: SONNET, fromModel: OPUS });
    expect(r.toasts.at(-1)).toBe('agento: sonnet for the rest of this task');
    expect(r.ledger?.hints.accepted).toBe(1);
    r.steps.length = 0;
    await step($, { model: OPUS, effort: 'high', index: 9 });
    expect(r.steps[0]?.model).toBe(SONNET);
    expect(r.model).toBe(OPUS);
  });

  test('a new task starts from nothing: the verdict, the counts and the banner\'s turn come again', async ($, on) => {
    const r = rig(on);
    await smallTask($, r);
    expect(r.task?.trajectoryVerdict).not.toBeNull();
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, TASK);
    expect(r.task?.trajectoryVerdict ?? null).toBeNull();
    expect(r.task?.trajectory).toMatchObject({ steps: 0, edits: 0, hasEdit: false });
    for (let i = 0; i < 3; i++) await round($, r, i, read(0));
    await round($, r, 3, edit);
    expect(r.banner?.scenario).toBe('S3');
    expect(r.ledger?.hints.shown).toBe(2);
  });

  test('russian text when LANG is ru', async ($, on) => {
    const r = rig(on, { lang: 'ru_RU.UTF-8' });
    await smallTask($, r);
    expect(r.banner?.title).toContain('небольшой');
    expect(r.banner?.actions.map((a) => a.label)).toEqual(['Sonnet', 'Оставить', 'Не предлагать']);
  });

  test('fail-open: a failing model read does not fail the tool call or the step', async ($, on) => {
    const r = rig(on, { throwOn: ['session.model'] });
    await start($);
    await prompt($, TASK);
    for (let i = 0; i < 5; i++) await round($, r, i, read(0));
    expect(r.steps).toHaveLength(5);
  });
});
