import { describe, expect, test, type Engine } from 'claude-code/testing';
import { HAIKU, OPUS, SONNET, rig, step, T0 } from './rig.ts';

const SPAWN_BASE = { parentModel: OPUS, provider: { plugin: 'engine', tier: 'core' } };
const spawn = ($: Engine, args: Record<string, unknown>) => $.agent.spawn({ ...SPAWN_BASE, ...args } as never);

describe('T15: ledger observes turn.step', () => {
  test('cost is right and model/effort are untouched (P1)', async ($, on) => {
    const r = rig(on);
    const result = await step($, { model: OPUS, effort: 'high' });
    // The engine below saw exactly what was asked for.
    expect(r.steps).toEqual([{ model: OPUS, effort: 'high', agentId: undefined }]);
    // The response comes back as the engine made it.
    expect(result.answer).toBe('ok');
    expect(result.usage?.model).toBe(OPUS);
    const l = r.ledger;
    expect(l?.steps).toBe(1);
    // Spec 5.2 reference: opus 5.5, 100k read + 3k write(5m) + 1.5k out = $0.065.
    expect(Math.abs((l?.cost ?? 0) - 0.065)).toBeLessThan(1e-9);
    expect(Math.abs((l?.baselineCost ?? 0) - 0.065)).toBeLessThan(1e-9);
    expect(l?.baselineModel).toBe(OPUS);
    expect(l?.main).toEqual({ model: OPUS, effort: 'high' });
    const s = l?.recent[0];
    expect(s?.lineage).toBe('main');
    expect(s?.model).toBe(OPUS);
    expect(s?.effort).toBe('high');
    expect(s?.tokens).toEqual({ input: 0, output: 1500, cacheRead: 100_000, cacheWrite: 3000 });
    expect(s?.mechanism).toBeNull();
    expect(l?.byModel[OPUS]?.steps).toBe(1);
  });

  test('baseline cost reprices the same tokens at the session start model', async ($, on) => {
    const r = rig(on);
    await step($, { model: OPUS });
    r.usage.model = SONNET;
    await step($, { model: SONNET, effort: 'medium', index: 1 });
    const l = r.ledger;
    expect(l?.baselineModel).toBe(OPUS);
    const second = l?.recent[1];
    expect(Math.abs((second?.cost ?? 0) - 0.0425)).toBeLessThan(1e-9);
    expect(Math.abs((second?.baselineCost ?? 0) - 0.065)).toBeLessThan(1e-9);
    expect(l?.main?.model).toBe(SONNET);
  });

  test('a subagent step has its own lineage and cache', async ($, on) => {
    const r = rig(on);
    await step($);
    await step($, { agentId: 'a1', model: HAIKU, index: 1 });
    const l = r.ledger;
    expect(Object.keys(l?.lineages ?? {}).sort()).toEqual(['agent:a1', 'main']);
    expect(l?.recent[1]?.lineage).toBe('agent:a1');
    // The status line keeps showing the main thread.
    expect(l?.main?.model).toBe(OPUS);
  });

  test('unknown model: no cost, no failure', async ($, on) => {
    const r = rig(on);
    r.usage.model = 'some-gateway-model';
    const result = await step($, { model: 'some-gateway-model' });
    expect(result.answer).toBe('ok');
    const l = r.ledger;
    expect(l?.steps).toBe(1);
    expect(l?.recent[0]?.cost).toBeNull();
    expect(l?.cost).toBe(0);
  });

  test('status line: model, effort, session cost, cache warm minutes (API key)', async ($, on) => {
    const r = rig(on, { auth: 'api-key' });
    await step($);
    const line = r.statuses[r.statuses.length - 1] ?? '';
    // 5m TTL less the 30 s margin, floored to whole minutes.
    expect(line).toMatch(/^opus·high · \$0\.0[67] · cache ● 4m$/);
  });

  test('status line for a subscriber shows the 7-day limit instead of dollars', async ($, on) => {
    const r = rig(on, { auth: 'bearer', rateLimits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 63.4 }] });
    await step($, { model: SONNET, effort: 'medium' });
    const line = r.statuses[r.statuses.length - 1] ?? '';
    // Subscriptions cache for 1h: 60m less the 30 s margin.
    expect(line).toBe('sonnet·med · 7d 63% · cache ● 59m');
    expect(r.ledger?.isSubscription).toBe(true);
    expect(r.ledger?.sevenDayPct).toBe(63.4);
  });

  test('a subscriber without a 7-day reading yet sees dollars', async ($, on) => {
    const r = rig(on, { auth: 'bearer', rateLimits: [] });
    await step($);
    expect(r.statuses[r.statuses.length - 1]).toMatch(/\$0\.0[67]/);
  });

  test('an account detected by its rate limits counts as a subscription', async ($, on) => {
    const r = rig(on, { auth: null, rateLimits: [{ kind: 'seven_day', percentUsed: 5 }] });
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    expect(r.ledger?.isSubscription).toBe(true);
  });

  test('cache goes cold in the status line as the clock runs', async ($, on) => {
    const r = rig(on, { auth: 'api-key' });
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    await step($);
    expect(r.statuses[r.statuses.length - 1]).toMatch(/cache ● 4m$/);
    await r.clock.advance(6 * 60_000);
    expect(r.statuses[r.statuses.length - 1]).toMatch(/cache ○$/);
  });

  test('1h TTL is read from the usage and from a subscription', async ($, on) => {
    const r = rig(on, { auth: 'bearer' });
    await step($);
    expect(r.ledger?.lineages.main?.ttl).toBe('1h');
  });

  test('daily aggregate lands in $.store, keyed by day', async ($, on) => {
    const r = rig(on);
    await step($);
    await step($, { index: 1 });
    const keys = [...r.store.keys()].filter((k) => k.startsWith('day:'));
    expect(keys.length).toBe(1);
    const d = r.store.get(keys[0] as string) as { steps: number; cost: number; tokens: { cacheRead: number }; byModel: Record<string, { steps: number }> };
    expect(d.steps).toBe(2);
    expect(Math.abs(d.cost - 0.13)).toBeLessThan(1e-9);
    expect(d.tokens.cacheRead).toBe(200_000);
    expect(d.byModel[OPUS]?.steps).toBe(2);
  });

  test('days older than 90 are pruned, recent ones kept', async ($, on) => {
    const dayOf = (ms: number) => {
      const d = new Date(ms);
      return `day:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const old = dayOf(T0 - 120 * 86_400_000);
    const recent = dayOf(T0 - 30 * 86_400_000);
    const r = rig(on, { store: { [old]: { steps: 1 }, [recent]: { steps: 1 }, other: 1 } });
    await step($);
    const keys = [...r.store.keys()];
    expect(keys).not.toContain(old);
    expect(keys).toContain(recent);
    expect(keys).toContain('other');
  });

  test('the ledger knows the mode', async ($, on) => {
    const r = rig(on);
    await step($);
    expect(r.ledger?.mode).toBe('balanced');
  });
});

describe('T15: mode', () => {
  test('quality still observes, and never changes the request', { options: { mode: 'quality' } }, async ($, on) => {
    const r = rig(on);
    await step($);
    expect(r.steps).toEqual([{ model: OPUS, effort: 'high', agentId: undefined }]);
    expect(r.ledger?.steps).toBe(1);
    expect(r.ledger?.mode).toBe('quality');
  });

  test('off does nothing at all', { options: { mode: 'off' } }, async ($, on) => {
    const r = rig(on);
    const result = await step($);
    await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    r.toolIsError = true;
    for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(result.answer).toBe('ok');
    expect(r.ledger).toBeUndefined();
    expect(r.statuses).toEqual([]);
    expect(r.toasts).toEqual([]);
    expect(r.spawns[0]?.model).toBeUndefined();
  });
});

describe('P5: fail-open', () => {
  test('a failing store does not fail the step', async ($, on) => {
    const r = rig(on, { throwOn: ['store.set'] });
    const result = await step($);
    expect(result.answer).toBe('ok');
    expect(result.usage?.model).toBe(OPUS);
  });

  test('a failing state write does not fail the step, the spawn or the tool call', async ($, on) => {
    const r = rig(on, { throwOn: ['state.set'] });
    const result = await step($);
    expect(result.answer).toBe('ok');
    expect(result.usage?.model).toBe(OPUS);
    const res = await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    expect(res.model).toBe('haiku');
    r.toolIsError = true;
    let last;
    for (let i = 0; i < 4; i++) last = await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(last?.text).toBe('failed');
    expect(r.ledger).toBeUndefined();
  });

  test('a failing status line does not fail the step', async ($, on) => {
    const r = rig(on, { throwOn: ['ui.status'] });
    const result = await step($);
    expect(result.answer).toBe('ok');
  });

  test('a failing usage read does not fail the step (subscriber)', async ($, on) => {
    const r = rig(on, { auth: 'bearer', throwOn: ['session.usage'] });
    const result = await step($);
    expect(result.answer).toBe('ok');
    expect(r.ledger?.steps).toBe(1);
  });

  test('a rewritten spawn that the engine refuses falls back to the original', async ($, on) => {
    const r = rig(on, { throwOn: ['agent.spawn:haiku'] });
    const res = await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    expect(res.agentId).toBe('ag2');
    expect(r.spawns.map((s) => s.model)).toEqual(['haiku', undefined]);
    expect(r.ledger).toBeUndefined();
  });
});

describe('T16: agent.spawn routing', () => {
  test('Explore with a search prompt from an opus parent runs on haiku', async ($, on) => {
    const r = rig(on);
    const res = await spawn($, { subagentType: 'Explore', prompt: 'Search the repo for every caller of parseConfig' });
    expect(res.model).toBe('haiku');
    expect(r.spawns[0]?.model).toBe('haiku');
    const l = r.ledger;
    expect(l?.decisions).toHaveLength(1);
    expect(l?.decisions[0]).toMatchObject({ agentId: 'ag1', subagentType: 'Explore', parentModel: OPUS, model: 'haiku', reason: 'explore-agent', mechanism: 'spawn-routing' });
    expect(l?.routed.ag1?.model).toBe('haiku');
  });

  test('russian search prompt on general-purpose goes to haiku', async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'general-purpose', prompt: 'Найди все места, где читается конфиг, и сделай сводку' });
    expect(r.spawns[0]?.model).toBe('haiku');
  });

  test('implementation on general-purpose goes to sonnet', async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'general-purpose', prompt: 'Implement the retry helper and add tests' });
    expect(r.spawns[0]?.model).toBe('sonnet');
  });

  test('an explicit model is untouched', async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo', model: 'opus' });
    expect(r.spawns[0]?.model).toBe('opus');
    // Recorded for the pane, as the model that was asked for; nothing is credited for it.
    expect(r.ledger?.decisions).toHaveLength(1);
    expect(r.ledger?.decisions[0]).toMatchObject({ model: 'opus', parentModel: OPUS, reason: 'explicit-model' });
    expect(r.ledger?.routed ?? {}).toEqual({});
  });

  test('never above the parent', async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'general-purpose', prompt: 'Implement the retry helper', parentModel: HAIKU });
    await spawn($, { subagentType: 'Explore', prompt: 'find x', parentModel: HAIKU });
    expect(r.spawns.map((s) => s.model)).toEqual([undefined, undefined]);
  });

  test('fork, Plan, agento agents and plugin-supplied agents are untouched', async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'fork', prompt: 'find usages', fork: true });
    await spawn($, { subagentType: 'Plan', prompt: 'find the files and plan' });
    await spawn($, { subagentType: 'agento:scout', prompt: 'find usages' });
    await spawn($, { subagentType: 'acme:finder', prompt: 'find usages', provider: { plugin: 'acme', tier: 'user' } });
    expect(r.spawns.map((s) => s.model)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('the cost of a routed subagent is credited as a spawn-routing estimate', async ($, on) => {
    const r = rig(on);
    await step($); // main on opus
    const res = await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    r.usage.model = HAIKU;
    await step($, { agentId: res.agentId, model: HAIKU, effort: undefined, index: 1 });
    const l = r.ledger;
    const s = l?.recent[1];
    expect(s?.lineage).toBe(`agent:${res.agentId}`);
    expect(s?.mechanism).toBe('spawn-routing');
    // Same tokens: opus 0.065 vs haiku 0.02125.
    expect(Math.abs((s?.cost ?? 0) - 0.02125)).toBeLessThan(1e-9);
    expect(Math.abs((s?.savedEstimate ?? 0) - (0.065 - 0.02125))).toBeLessThan(1e-9);
    expect(Math.abs((l?.savedEstimate.spawnRouting ?? 0) - (0.065 - 0.02125))).toBeLessThan(1e-9);
    const day = r.store.get([...r.store.keys()].find((k) => k.startsWith('day:')) as string) as { routedSpawns: number; savedEstimate: { spawnRouting: number } };
    expect(day.routedSpawns).toBe(1);
    expect(day.savedEstimate.spawnRouting).toBeGreaterThan(0.04);
  });

  test('main steps are never credited with routing savings', async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    await step($);
    expect(r.ledger?.savedEstimate.spawnRouting).toBe(0);
  });
});

describe('T16: mode setting', () => {
  test('quality never touches a spawn', { options: { mode: 'quality' } }, async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    expect(r.spawns[0]?.model).toBeUndefined();
    // Not touched, but recorded: the pane shows the model it kept.
    expect(r.ledger?.decisions).toHaveLength(1);
    expect(r.ledger?.decisions[0]).toMatchObject({ model: OPUS, parentModel: OPUS, reason: 'mode-quality' });
    expect(r.ledger?.routed ?? {}).toEqual({});
  });

  test('eco routes like balanced', { options: { mode: 'eco' } }, async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    expect(r.spawns[0]?.model).toBe('haiku');
  });

  test('the default mode is balanced', async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    expect(r.spawns[0]?.model).toBe('haiku');
  });

  test('an unknown mode value falls back to balanced', { options: { mode: 'turbo' } }, async ($, on) => {
    const r = rig(on);
    await spawn($, { subagentType: 'Explore', prompt: 'find usages of foo' });
    expect(r.spawns[0]?.model).toBe('haiku');
  });
});

describe('T17: loop guard on tool.call (S7 banner)', () => {
  test('three failing test runs raise one S7 banner, once, and no toast', async ($, on) => {
    const r = rig(on);
    r.toolIsError = true;
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npx vitest run auth.spec' });
    expect(r.toasts).toHaveLength(0);
    expect(r.banner?.scenario).toBe('S7');
    expect(r.banner?.title).toBe('The agent looks stuck');
    expect(r.banner?.reason).toBe('test failing for the 3rd time: npx vitest run auth.spec');
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['stop', 'hint', 'continue']);
    const l = r.ledger;
    expect(l?.signals).toHaveLength(1);
    expect(l?.signals[0]).toMatchObject({ kind: 'failing-test', count: 3, lineage: 'main' });
    expect(l?.hints.shown).toBe(1);
  });

  test('error streak banner, and anti-spam for the next steps', async ($, on) => {
    const r = rig(on);
    r.toolIsError = true;
    for (let i = 0; i < 8; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(r.ledger?.signals).toHaveLength(1);
    expect(r.banner?.reason).toContain('4 tool errors in a row');
  });

  test('same-edit banner', async ($, on) => {
    const r = rig(on);
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'return foo(x)', new_string: 'return bar(x)' });
    expect(r.banner?.reason).toContain('same spot edited 3 times: /a.ts');
  });

  test('russian banner when LANG is ru', async ($, on) => {
    const r = rig(on, { lang: 'ru_RU.UTF-8' });
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(r.banner?.title).toBe('Агент буксует');
    expect(r.banner?.reason).toBe('4 ошибок инструментов подряд');
  });

  test('healthy work raises nothing and the tool result is untouched', async ($, on) => {
    const r = rig(on);
    for (let i = 0; i < 6; i++) {
      const res = await $.tool.call({ tool: 'Bash', command: 'ls' });
      expect(res.text).toBe('ok');
    }
    expect(r.banner).toBeUndefined();
    expect(r.tools).toHaveLength(6);
  });

  test('a failing state write does not fail the tool call', async ($, on) => {
    const r = rig(on, { throwOn: ['state.set'] });
    r.toolIsError = true;
    let last;
    for (let i = 0; i < 4; i++) last = await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(last?.text).toBe('failed');
  });

  test('/clear resets the guard', async ($, on) => {
    const r = rig(on);
    r.toolIsError = true;
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(r.banner).toBeNull();
    expect(r.ledger?.signals ?? []).toHaveLength(0);
  });
});
