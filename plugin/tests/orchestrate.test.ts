import { describe, expect, test, type Engine } from 'claude-code/testing';
import { manualTest, prompt, rig, slash, step } from './rig.ts';

const ID = 'agento:orchestrate';
// The facts a request is composed for, as the engine resolves them.
const FACTS = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['Read', 'Bash'], outputStyle: null, traits: [] } as const;
const compose = ($: Engine, over: Record<string, unknown> = {}) => $.prompt.compose({ ...FACTS, ...over } as never);
const section = (r: { sections: ReadonlyArray<{ id: string; text: string; scope: string }> }) => r.sections.find((s) => s.id === ID);
const start = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });

describe('T20: orchestrator mode (P7)', () => {
  test('on by default', async ($, on) => {
    rig(on);
    await start($);
    expect(section(await compose($))).toBeDefined();
  });

  test('off: the system prompt gets nothing from agento', { options: { orchestrate: 'off' } }, async ($, on) => {
    rig(on);
    await start($);
    const r = await compose($);
    expect(section(r)).toBeUndefined();
    expect(r.sections.map((s) => s.id)).toEqual(['intro', 'memory']);
  });

  test('on at session start: one session-scope section, last, at most 25 lines, naming the three agents', { options: { orchestrate: 'on' } }, async ($, on) => {
    rig(on);
    await start($);
    const r = await compose($);
    const s = section(r);
    expect(s?.scope).toBe('session');
    expect(r.sections.at(-1)?.id).toBe(ID);
    expect(r.sections.filter((x) => x.id === ID)).toHaveLength(1);
    expect(s?.text.split('\n').length).toBeLessThanOrEqual(25);
    for (const a of ['agento-scout', 'agento-builder', 'agento-checker']) expect(s?.text).toContain(a);
    // The rest of the prompt is the engine's, untouched and in order.
    expect(r.sections.slice(0, 2)).toEqual([{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }, { id: 'memory', text: 'memory', scope: 'session' }]);
  });

  test('two prompt.compose calls in one session yield identical sections — and so do all the later ones', { options: { orchestrate: 'on' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    const a = await compose($);
    const b = await compose($);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Through prompts, steps, time, a /clear, a compaction, a stuck agent: still byte-identical.
    await prompt($, 'Исправь опечатку в README');
    await step($);
    await r.clock.advance(3 * 3_600_000);
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never);
    const c = await compose($);
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(section(c)?.text).toBe(section(a)?.text);
  });

  manualTest('a reload mid-session (a setting changed, so session.start runs again) changes nothing the session started with', async ($, on) => {
    rig(on);
    await start($);
    const a = await compose($);
    await slash($, 'agento', 'orchestrate on');
    await start($);
    expect(JSON.stringify(await compose($))).toBe(JSON.stringify(a));
    expect(section(await compose($))).toBeUndefined();
  });

  test('a session that started in mode off and was switched on mid-session gets no section either', { options: { mode: 'off', orchestrate: 'on' } }, async ($, on) => {
    rig(on);
    await start($);
    const a = await compose($);
    await slash($, 'agento', 'mode balanced');
    await start($);
    expect(JSON.stringify(await compose($))).toBe(JSON.stringify(a));
  });

  test('other facts of the request (model, tools) do not change the text', { options: { orchestrate: 'on' } }, async ($, on) => {
    rig(on);
    await start($);
    const a = await compose($);
    const b = await compose($, { model: 'claude-haiku-4-5', promptModel: 'claude-haiku-4-5', tools: ['Read'], traits: ['lean'] });
    expect(section(b)?.text).toBe(section(a)?.text);
  });

  test('language from LANG: russian', { options: { orchestrate: 'on' } }, async ($, on) => {
    rig(on, { lang: 'ru_RU.UTF-8' });
    await start($);
    const s = section(await compose($));
    expect(s?.text).toContain('# Делегирование (agento)');
    expect(s?.text.split('\n').length).toBeLessThanOrEqual(25);
  });

  test('language from LANG: english otherwise', { options: { orchestrate: 'on' } }, async ($, on) => {
    rig(on, { lang: 'en_US.UTF-8' });
    await start($);
    expect(section(await compose($))?.text).toContain('# Delegation (agento)');
  });

  test('the lang option wins over LANG', { options: { orchestrate: 'on', lang: 'ru' } }, async ($, on) => {
    rig(on, { lang: 'en_US.UTF-8' });
    await start($);
    expect(section(await compose($))?.text).toContain('Делегирование');
  });

  manualTest('turning it on mid-session does not touch this session\'s prompt (the setting applies from the next one)', async ($, on) => {
    const r = rig(on);
    await start($);
    const before = await compose($);
    const res = await slash($, 'agento', 'orchestrate on');
    expect(r.configs).toEqual([{ key: 'agento.orchestrate', value: 'on' }]);
    expect(res.text).toContain('applies from the next session');
    const after = await compose($);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(section(after)).toBeUndefined();
  });

  test('turning it off mid-session does not remove it either', { options: { orchestrate: 'on' } }, async ($, on) => {
    const r = rig(on);
    await start($);
    const before = await compose($);
    await slash($, 'agento', 'orchestrate off');
    expect(r.configs).toEqual([{ key: 'agento.orchestrate', value: 'off' }]);
    expect(JSON.stringify(await compose($))).toBe(JSON.stringify(before));
  });

  test('agento mode off adds nothing, even with orchestrate on', { options: { orchestrate: 'on', mode: 'off' } }, async ($, on) => {
    rig(on);
    await start($);
    expect(section(await compose($))).toBeUndefined();
  });

  test('the section never carries anything session-specific: no cwd, no model, no date', { options: { orchestrate: 'on' } }, async ($, on) => {
    rig(on, { cwd: '/secret/project' });
    await start($);
    const t = section(await compose($))?.text ?? '';
    expect(t).not.toContain('/secret');
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(t).not.toMatch(/opus|fable/i);
  });
});
