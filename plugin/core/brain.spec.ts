import { describe, expect, it } from 'vitest';
import { BRAIN_TIMEOUT_MS, brainSocketPath, buildRouteBody, createBrainClassifier, parseBrainMode, parseBrainTimeout, parseHealth, parseRoute, startKindOf, verdictFromRoute, type BrainCall } from './brain.ts';
import type { LineageState } from './cache.ts';
import { decidePrompt, taskContextOf, type PromptFacts } from './suggest.ts';
import { rulesClassifier, type TaskContext, type TaskVerdict } from './task.ts';

const LIGHT = 'Исправь опечатку в README';
const CTX: TaskContext = { contextTokens: 0, isSessionStart: true, startKind: 'session' };
const NOW = 1_760_000_000_000;

const answer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ tier: 'haiku', effort: 'low', plan_first: false, delegate_explore: false, confidence: 0.9, abstain: false, latency_ms: 2.5, model_run_id: 'run-7', ...over });

const classifier = (call: (body: string) => Promise<BrainCall>) => createBrainClassifier({ call, fallback: rulesClassifier });
const replying = (text: string) => classifier(() => Promise.resolve({ ok: true, text }));

describe('request', () => {
  it('text is the prompt; context carries the header fields with the training vocabulary', () => {
    expect(JSON.parse(buildRouteBody(LIGHT, { contextTokens: 82_000.4, isSessionStart: false, startKind: 'cold' }, 'ru'))).toEqual({ text: LIGHT, context: { lang: 'ru', contextTokens: 82_000, startKind: 'cold' } });
  });
  it('repo languages only when known', () => {
    expect(JSON.parse(buildRouteBody('x', { ...CTX, languages: ['kotlin', 'ts'] }, 'en')).context.repo).toEqual(['kotlin', 'ts']);
    expect(JSON.parse(buildRouteBody('x', CTX, 'en')).context).not.toHaveProperty('repo');
  });
  it('startKind: session / clear (a compaction too) / cold (idle, explicit)', () => {
    expect(['first-prompt', 'clear', 'compact', 'idle', 'explicit'].map((r) => startKindOf(r as never))).toEqual(['session', 'clear', 'clear', 'cold', 'cold']);
  });
  it('a prompt full of braces and quotes survives as JSON', () => {
    const t = 'fix "{lang}" \\ \n```ts\nconst a = {b: 1}\n```';
    expect(JSON.parse(buildRouteBody(t, CTX, 'en')).text).toBe(t);
  });
});

describe('settings', () => {
  it('socket: override, else $AGENTO_HOME, else ~/.agento, else unknown', () => {
    expect(brainSocketPath('/run/b.sock', '/x', '/h')).toBe('/run/b.sock');
    expect(brainSocketPath('  ', '/x/', '/h')).toBe('/x/brain.sock');
    expect(brainSocketPath(undefined, undefined, '/Users/u/')).toBe('/Users/u/.agento/brain.sock');
    expect(brainSocketPath(undefined, '', '')).toBeNull();
  });
  it('timeout: a sane number, else the default of 400 ms', () => {
    expect(parseBrainTimeout(250)).toBe(250);
    expect(parseBrainTimeout('300')).toBe(300);
    for (const bad of [undefined, 'x', -1, 0, 5, 1e6, NaN, null]) expect(parseBrainTimeout(bad)).toBe(BRAIN_TIMEOUT_MS);
  });
  it('brain: off or auto', () => {
    expect([parseBrainMode('off'), parseBrainMode('auto'), parseBrainMode(undefined), parseBrainMode('on')]).toEqual(['off', 'auto', 'auto', 'auto']);
  });
});

describe('parseRoute', () => {
  it('a well-formed answer', () => {
    expect(parseRoute(answer())).toEqual({ tier: 'haiku', effort: 'low', planFirst: false, delegateExplore: false, confidence: 0.9, abstain: false, latencyMs: 2.5, runId: 'run-7' });
  });
  it('xhigh is high; the flags are only ever true or false', () => {
    expect(parseRoute(answer({ effort: 'xhigh', plan_first: 'yes' }))).toMatchObject({ effort: 'high', planFirst: false });
    expect(parseRoute(answer({ plan_first: true, delegate_explore: true }))).toMatchObject({ planFirst: true, delegateExplore: true });
  });
  it.each([
    ['not json', 'oops'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a tier without a word here', answer({ tier: 'fable' })],
    ['no tier', answer({ tier: undefined })],
    ['an unknown effort', answer({ effort: 'max' })],
    ['a string confidence', answer({ confidence: '0.9' })],
    ['a confidence above 1', answer({ confidence: 1.5 })],
    ['no run id', answer({ model_run_id: '' })],
  ])('%s: null', (_n, text) => {
    expect(parseRoute(text)).toBeNull();
  });
});

describe('verdictFromRoute', () => {
  it('maps tier, effort, confidence, plan_first, delegate_explore and names the classifier', () => {
    const a = parseRoute(answer({ plan_first: true, delegate_explore: true }));
    const v = verdictFromRoute(a!) as TaskVerdict;
    expect(v).toMatchObject({ tier: 'haiku', effort: 'low', confidence: 0.9, classifier: 'brain:run-7', planFirst: true, delegateExplore: true, latencyMs: 2.5 });
  });
  it('abstain and rules-v1 are no verdict', () => {
    expect(verdictFromRoute(parseRoute(answer({ abstain: true }))!)).toEqual({ skip: 'abstain' });
    expect(verdictFromRoute(parseRoute(answer({ model_run_id: 'rules-v1' }))!)).toEqual({ skip: 'rules-v1' });
  });
});

describe('parseHealth', () => {
  it('ok, run id and p50', () => {
    expect(parseHealth(JSON.stringify({ ok: true, model_run_id: 'r', backend: 'onnx', p50_ms: 3 }))).toEqual({ runId: 'r', backend: 'onnx', p50Ms: 3 });
    expect(parseHealth(JSON.stringify({ ok: true, model_run_id: 'r' }))).toEqual({ runId: 'r', backend: null, p50Ms: null });
  });
  it('anything else is no daemon', () => {
    for (const t of ['x', '[]', JSON.stringify({ ok: false, model_run_id: 'r' }), JSON.stringify({ ok: true })]) expect(parseHealth(t)).toBeNull();
  });
});

describe('the classifier', () => {
  it('uses the brain\'s verdict', async () => {
    expect(await replying(answer()).classify(LIGHT, CTX)).toMatchObject({ tier: 'haiku', classifier: 'brain:run-7' });
  });
  it('sends the body it builds, with the language the rules measure', async () => {
    let seen = '';
    await classifier((b) => ((seen = b), Promise.resolve({ ok: true, text: answer() }))).classify(LIGHT, CTX);
    expect(JSON.parse(seen)).toEqual({ text: LIGHT, context: { lang: 'ru', contextTokens: 0, startKind: 'session' } });
  });
  const local = { tier: 'sonnet', effort: 'medium', confidence: 0.7 };
  it.each([
    ['a timeout', { ok: false, reason: 'timeout' } as BrainCall, 'timeout'],
    ['an error', { ok: false, reason: 'error' } as BrainCall, 'error'],
    ['malformed JSON', { ok: true, text: '{' } as BrainCall, 'invalid'],
    ['an abstention', { ok: true, text: answer({ abstain: true }) } as BrainCall, 'abstain'],
    ['the daemon serving rules-v1', { ok: true, text: answer({ model_run_id: 'rules-v1' }) } as BrainCall, 'rules-v1'],
  ])('%s: the local rules, with the reason', async (_n, res, why) => {
    const v = await classifier(() => Promise.resolve(res)).classify(LIGHT, CTX);
    expect(v).toMatchObject({ ...local, classifier: 'rules-v1', fallback: why });
  });
  it('an abstention keeps the brain\'s yes/no heads over the rules\' tier and effort', async () => {
    const v = await replying(answer({ abstain: true, plan_first: true, delegate_explore: true })).classify(LIGHT, CTX);
    expect(v).toMatchObject({ ...local, classifier: 'rules-v1', fallback: 'abstain', planFirst: true, delegateExplore: true, latencyMs: 2.5 });
    expect(v.reasons).toEqual(expect.arrayContaining(['brain run-7: plan first', 'brain run-7: delegate exploring']));
  });
  it('a daemon serving rules-v1 has no heads to keep', async () => {
    const v = await replying(answer({ model_run_id: 'rules-v1', plan_first: true })).classify(LIGHT, CTX);
    expect(v.planFirst).toBeUndefined();
  });
  it('a call that throws is the rules too (fail-open)', async () => {
    const v = await classifier(() => Promise.reject(new Error('boom'))).classify(LIGHT, CTX);
    expect(v).toMatchObject({ ...local, classifier: 'rules-v1', fallback: 'error' });
  });
});

describe('through the guards (decidePrompt)', () => {
  const warm = (tokens: number): LineageState => ({ model: 'claude-opus-5-5', prefixTokens: tokens, lastAt: NOW - 60_000, ttl: '5m' });
  const facts = (over: Partial<PromptFacts> = {}): PromptFacts => ({
    mode: 'balanced', autopilot: 'off', suggestions: true, prompt: LIGHT, prevPrompt: '', isFirstPrompt: true, marker: null, explicitNew: false,
    mainCache: undefined, now: NOW, current: { model: 'claude-opus-5-5', effort: 'high' }, contextTokens: 0, dismissed: [], shown: [], ...over,
  });
  const brainVerdict = (over: Partial<TaskVerdict> = {}): TaskVerdict => ({ tier: 'haiku', effort: 'low', confidence: 0.9, reasons: ['brain'], classifier: 'brain:run-7', ...over });

  it('a brain verdict at a task start replaces the rules\'', () => {
    const d = decidePrompt(facts({ verdict: brainVerdict() }));
    expect(d.verdict?.classifier).toBe('brain:run-7');
    expect(d.action).toMatchObject({ kind: 'S1', down: { model: 'haiku' } });
  });
  it('below the mode\'s threshold: nothing (balanced 0.65, eco 0.55)', () => {
    expect(decidePrompt(facts({ verdict: brainVerdict({ confidence: 0.6 }) })).action.kind).toBe('none');
    expect(decidePrompt(facts({ mode: 'eco', verdict: brainVerdict({ confidence: 0.6 }) })).action.kind).toBe('S1');
  });
  it('P3: opus from the brain never lowers or raises anything for a user on sonnet', () => {
    const d = decidePrompt(facts({ current: { model: 'claude-sonnet-5-5', effort: 'medium' }, verdict: brainVerdict({ tier: 'opus', effort: 'high', confidence: 0.95 }) }));
    expect(d.action.kind).not.toBe('S1');
    expect(d.action.kind).not.toBe('autopilot');
  });
  it('P1: mid-task (no task start) the verdict is ignored', () => {
    const d = decidePrompt(facts({ isFirstPrompt: false, mainCache: warm(20_000), verdict: brainVerdict() }));
    expect(d.verdict).toBeNull();
    expect(d.action.kind).toBe('none');
  });
  it('plan_first makes a planning task even when the tier is sonnet (S2)', () => {
    const d = decidePrompt(facts({ current: { model: 'claude-sonnet-5-5', effort: 'medium' }, verdict: brainVerdict({ tier: 'sonnet', effort: 'medium', confidence: 0.8, planFirst: true }) }));
    expect(d.action.kind).toBe('S2a');
  });
  it('plan_first does not wait on the tier\'s confidence (an abstaining tier leaves the rules\' low one)', () => {
    const d = decidePrompt(facts({ current: { model: 'claude-sonnet-5-5', effort: 'medium' }, verdict: brainVerdict({ tier: 'sonnet', effort: 'medium', confidence: 0.3, planFirst: true }) }));
    expect(d.action.kind).toBe('S2a');
  });
  it('autopilot at a clean point takes the brain\'s downgrade', () => {
    const d = decidePrompt(facts({ autopilot: 'clean-points', verdict: brainVerdict() }));
    expect(d.action).toMatchObject({ kind: 'autopilot', down: { model: 'haiku', effort: 'low' } });
  });
  it('the classifier is told what the start was', () => {
    expect(taskContextOf({ reason: 'idle', freeSwitch: true, contextTokens: 50_000 }, 50_000)).toEqual({ contextTokens: 50_000, isSessionStart: false, startKind: 'cold' });
  });
});
