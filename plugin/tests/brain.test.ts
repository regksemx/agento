import { describe, expect, test, type Engine } from 'claude-code/testing';
import { OPUS, SONNET, prompt, rig, slash, step, type BrainReply, type HttpCall, type Rig } from './rig.ts';

const LIGHT = 'Исправь опечатку в README';
const FIRST = 'Добавь тесты для парсера конфигурации и обработку ошибок';
const NEUTRAL = 'Добавь тесты для парсера конфигурации';
const SOCK = '/home/u/.agento/brain.sock';

const start = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
const PANE = { title: 'agento', isFocused: false, bodyColumns: 90, placement: 'inline', scroll: { bodyRows: 20 } } as never;
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'agento', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'agento', viewport: { columns: 100, rows: 30 } });

const HEALTH = { ok: true, model_run_id: 'run-7', backend: 'onnx', p50_ms: 3.2 };
const route = (over: Record<string, unknown> = {}) => ({
  json: { tier: 'haiku', effort: 'low', plan_first: false, delegate_explore: false, confidence: 0.9, abstain: false, latency_ms: 2.5, model_run_id: 'run-7', ...over },
});

// A daemon that answers /healthz and routes with `onRoute`.
const daemon =
  (onRoute: (call: HttpCall) => BrainReply = () => route()) =>
  (call: HttpCall): BrainReply =>
    call.url.endsWith('/healthz') ? { json: HEALTH } : onRoute(call);

const routes = (r: Rig) => r.http.filter((c) => c.url.endsWith('/v1/route'));
const probes = (r: Rig) => r.http.filter((c) => c.url.endsWith('/healthz'));

// A run that has to wait out a timeout on the mocked clock.
async function advancing<T>($: Engine, r: Rig, work: Promise<T>): Promise<T> {
  let done = false;
  const p = work.then((x) => {
    done = true;
    return x;
  });
  for (let i = 0; i < 20 && !done; i += 1) await r.clock.advance(100);
  return p;
}

describe('T37: the trained classifier at a clean point', () => {
  test('the daemon answers: its verdict is used, the request follows the contract, and the ledger names it', async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await prompt($, LIGHT);
    // (The first session.start of a loaded module may run twice: only that a probe came first matters.)
    expect(r.http[0]).toMatchObject({ url: 'http://localhost/healthz', socketPath: SOCK, method: 'GET' });
    expect(routes(r)).toHaveLength(1);
    expect(routes(r)[0]).toMatchObject({ url: 'http://localhost/v1/route', method: 'POST', socketPath: SOCK });
    expect(JSON.parse(routes(r)[0]?.body ?? '')).toEqual({ text: LIGHT, context: { lang: 'ru', contextTokens: 0, startKind: 'session' } });
    // Rules would say sonnet; the brain said haiku.
    expect(r.banner?.scenario).toBe('S1');
    expect(r.banner?.data).toMatchObject({ model: 'haiku', fromModel: OPUS });
    expect(r.ledger?.routes).toEqual([{ ts: expect.any(Number), classifier: 'brain:run-7', tier: 'haiku', effort: 'low', confidence: 0.9, planFirst: false, delegateExplore: false, latencyMs: 2.5, action: 'S1' }]);
    // The prompt goes on as typed.
    expect(r.submitted).toEqual([{ text: LIGHT, context: undefined }]);
  });

  test('the brain\'s verdict goes through the same guards: the mode\'s confidence threshold', async ($, on) => {
    const r = rig(on, { brain: daemon(() => route({ confidence: 0.6 })) });
    await start($);
    await prompt($, LIGHT);
    // balanced needs 0.65
    expect(r.banner?.scenario).not.toBe('S1');
    expect(r.ledger?.routes?.[0]).toMatchObject({ classifier: 'brain:run-7', confidence: 0.6, action: 'none' });
  });

  test('autopilot holds the brain\'s choice for the task: its requests go out on haiku', { options: { autopilot: 'clean-points' } }, async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await prompt($, LIGHT);
    expect(r.task?.override).toMatchObject({ model: 'haiku', modelId: 'claude-haiku-4-5', fromModel: OPUS });
    expect(r.commands).toEqual([]);
    await step($, { model: r.model, effort: 'high' });
    expect(r.steps).toEqual([{ model: 'claude-haiku-4-5', effort: 'high', agentId: undefined }]);
  });

  test('a socket given in the settings, and AGENTO_HOME, decide where the daemon is', async ($, on) => {
    const a = rig(on, { brain: daemon(), env: { AGENTO_HOME: '/srv/agento/' } });
    await start($);
    await prompt($, LIGHT);
    expect(probes(a)[0]?.socketPath).toBe('/srv/agento/brain.sock');
  });

  test('brainSocket overrides the default path', { options: { brainSocket: '/run/b.sock' } }, async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await prompt($, LIGHT);
    expect(probes(r)[0]?.socketPath).toBe('/run/b.sock');
    expect(routes(r)[0]?.socketPath).toBe('/run/b.sock');
  });

  test('a daemon that does not answer in time: the rules decide, and it is not asked again', async ($, on) => {
    const r = rig(on, { brain: daemon(() => 'hang') });
    await start($);
    await advancing($, r, prompt($, LIGHT));
    // The rules' verdict for a light task: sonnet.
    expect(r.banner?.data).toMatchObject({ model: 'sonnet' });
    expect(r.ledger?.routes?.[0]).toMatchObject({ classifier: 'rules-v1', fallback: 'timeout', tier: 'sonnet', action: 'S1' });
    expect(r.submitted).toHaveLength(1);
    // Down: the next clean points, inside the five minutes, make no call at all.
    await r.clock.advance(60_000);
    r.http.length = 0;
    await slash($, 'agento', 'new');
    await prompt($, LIGHT);
    expect(r.http).toEqual([]);
  });

  const BAD: Array<[string, BrainReply, string]> = [
    ['malformed JSON', 'not json at all', 'invalid'],
    ['a JSON array', '[1,2]', 'invalid'],
    ['an unknown tier', JSON.stringify({ tier: 'fable', effort: 'low', confidence: 0.9, abstain: false, model_run_id: 'run-7' }), 'invalid'],
    ['a confidence out of range', JSON.stringify({ tier: 'haiku', effort: 'low', confidence: 7, abstain: false, model_run_id: 'run-7' }), 'invalid'],
    ['an HTTP error', { status: 500, json: { error: { code: 'x', message: 'y' } } }, 'http-500'],
    ['an abstention', route({ abstain: true }), 'abstain'],
    ['the daemon serving the rules', route({ model_run_id: 'rules-v1', tier: 'sonnet', effort: 'medium' }), 'rules-v1'],
  ];
  for (const [name, reply, why] of BAD) test(`${name}: the local rules decide`, async ($, on) => {
    const r = rig(on, { brain: daemon(() => reply) });
    await start($);
    await prompt($, LIGHT);
    expect(routes(r)).toHaveLength(1);
    expect(r.banner?.data).toMatchObject({ model: 'sonnet' });
    expect(r.ledger?.routes?.[0]).toMatchObject({ classifier: 'rules-v1', fallback: why, tier: 'sonnet' });
    // The daemon is up: it is asked again at the next clean point.
    await r.clock.advance(6 * 60_000);
    await slash($, 'agento', 'new');
    await prompt($, LIGHT);
    expect(routes(r)).toHaveLength(2);
  });

  test('P3: the brain says opus while the user is on sonnet: nothing is raised', { options: { autopilot: 'clean-points' } }, async ($, on) => {
    const r = rig(on, { model: SONNET, brain: daemon(() => route({ tier: 'opus', effort: 'high', confidence: 0.95 })) });
    await start($);
    await prompt($, NEUTRAL);
    expect(routes(r)).toHaveLength(1);
    expect(r.task?.override).toBeNull();
    expect(r.banner?.scenario).not.toBe('S1');
    expect(r.banner?.scenario).not.toBe('AP');
    expect(r.commands).toEqual([]);
    await step($, { model: SONNET, effort: 'medium' });
    expect(r.steps).toEqual([{ model: SONNET, effort: 'medium', agentId: undefined }]);
    expect(r.model).toBe(SONNET);
  });

  test('P1: a verdict is only asked for at a clean point; mid-task prompts never reach the daemon, and the hold stays', { options: { autopilot: 'clean-points' } }, async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await prompt($, LIGHT);
    expect(routes(r)).toHaveLength(1);
    expect(r.task?.override).toMatchObject({ model: 'haiku' });
    const held = r.task?.override;
    r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
    await step($, { model: r.model });
    // The next prompt, a minute later, on a warm cache: no task start.
    await r.clock.advance(60_000);
    await prompt($, 'Спроектируй архитектуру распределённой очереди');
    expect(routes(r)).toHaveLength(1);
    expect(r.task?.override).toEqual(held);
    expect(r.ledger?.routes).toHaveLength(1);
  });

  test('plan_first from the brain offers the plan handoff (S2) to a user on sonnet', async ($, on) => {
    const r = rig(on, { model: SONNET, brain: daemon(() => route({ tier: 'sonnet', effort: 'medium', plan_first: true, delegate_explore: true, confidence: 0.8 })) });
    await start($);
    await prompt($, NEUTRAL);
    expect(r.banner?.scenario).toBe('S2a');
    // delegate_explore is recorded and nothing acts on it.
    expect(r.ledger?.routes?.[0]).toMatchObject({ classifier: 'brain:run-7', planFirst: true, delegateExplore: true, action: 'S2a' });
    expect(r.spawns).toEqual([]);
  });

  test('no daemon: no call after the probe, until the probe is due again (5 minutes)', async ($, on) => {
    let up = false;
    const r = rig(on, { brain: (c) => (up ? daemon()(c) : 'refuse') });
    await start($);
    await r.clock.advance(0);
    expect(probes(r)).toHaveLength(1);
    await prompt($, LIGHT);
    expect(r.ledger?.routes?.[0]).toMatchObject({ classifier: 'rules-v1', fallback: 'unavailable' });
    expect(r.banner?.data).toMatchObject({ model: 'sonnet' });
    expect(r.http).toHaveLength(1);
    // Still inside the five minutes: no fetch at all, however many clean points.
    for (let i = 0; i < 3; i += 1) {
      await r.clock.advance(65_000);
      await slash($, 'agento', 'new');
      await prompt($, LIGHT);
    }
    expect(r.http).toHaveLength(1);
    // Due: a probe (and now the daemon is there, so the route call follows).
    up = true;
    await r.clock.advance(2 * 60_000);
    await slash($, 'agento', 'new');
    await prompt($, LIGHT);
    expect(probes(r)).toHaveLength(2);
    expect(routes(r)).toHaveLength(1);
    expect(r.ledger?.routes?.[r.ledger.routes.length - 1]).toMatchObject({ classifier: 'brain:run-7' });
  });

  test('a call that fails marks the daemon down for the next five minutes', async ($, on) => {
    let broken = false;
    const r = rig(on, { brain: (c) => (broken ? 'refuse' : c.url.endsWith('/healthz') ? { json: HEALTH } : route()) });
    await start($);
    await prompt($, LIGHT);
    expect(routes(r)).toHaveLength(1);
    broken = true;
    await r.clock.advance(6 * 60_000);
    await slash($, 'agento', 'new');
    await prompt($, LIGHT);
    expect(routes(r)).toHaveLength(2);
    expect(r.ledger?.routes?.[1]).toMatchObject({ classifier: 'rules-v1', fallback: 'error' });
    await r.clock.advance(6 * 60_000);
    r.http.length = 0;
    await slash($, 'agento', 'new');
    await prompt($, LIGHT);
    // 6 minutes later: probed again (refused), no route call.
    expect(r.http.map((c) => c.url)).toEqual(['http://localhost/healthz']);
  });

  test('brain: off never touches the socket', { options: { brain: 'off' } }, async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await prompt($, LIGHT);
    expect(r.http).toEqual([]);
    expect(r.banner?.data).toMatchObject({ model: 'sonnet' });
    expect(r.ledger?.routes?.[0]).toMatchObject({ classifier: 'rules-v1' });
    expect(r.ledger?.routes?.[0]?.fallback).toBeUndefined();
  });

  test('mode quality: nothing is changed, and the daemon is not asked', { options: { mode: 'quality' } }, async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await prompt($, LIGHT);
    expect(routes(r)).toEqual([]);
    expect(r.banner).toBeFalsy();
  });

  test('a task started after /clear tells the daemon so (startKind clear)', async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await prompt($, FIRST);
    r.usage = { in: 0, out: 1500, read: 20_000, write: 3000 };
    await step($);
    await $.session.end({ sessionId: 's', reason: 'clear' } as never);
    await prompt($, LIGHT);
    expect(JSON.parse(routes(r)[1]?.body ?? '').context).toEqual({ lang: 'ru', contextTokens: 0, startKind: 'clear' });
  });

  test('the pane says who classifies', async ($, on) => {
    const r = rig(on, { brain: daemon() });
    await start($);
    await r.clock.advance(0);
    const ui = await mountPane($);
    expect((await ui.find({ key: 'val:Classifier' }))?.text).toBe('brain run-7 · p50 3.2 ms');
    await ui.unmount();
  });

  test('the pane without a daemon: rules-v1, local', async ($, on) => {
    rig(on);
    await start($);
    const ui = await mountPane($);
    expect((await ui.find({ key: 'val:Classifier' }))?.text).toContain('rules-v1 · local');
    await ui.unmount();
  });

  test('fail-open: a state write that fails does not keep the prompt or the rules\' banner from the user', async ($, on) => {
    const r = rig(on, { brain: daemon(), throwOn: ['ui.toast'] });
    await start($);
    await prompt($, LIGHT);
    expect(r.submitted).toHaveLength(1);
  });
});
