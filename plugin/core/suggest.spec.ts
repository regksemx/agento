import { describe, expect, it } from 'vitest';
import type { LineageState } from './cache.ts';
import { canReplace, decidePrompt, detectTaskStart, dismissKeyOf, downgradeFor, confidenceThreshold, makeOverride, overrideFor, type PromptFacts } from './suggest.ts';
import { modelIdForTier } from './pricing.ts';

const NOW = 1_760_000_000_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const FABLE = 'claude-fable-5-1';

const LIGHT = 'Исправь опечатку в README';
const HEAVY = 'Спроектируй архитектуру распределённой очереди задач с миграцией старых данных';

const warm = (tokens: number, ago = 60_000, model = OPUS): LineageState => ({ model, prefixTokens: tokens, lastAt: NOW - ago, ttl: '5m' });

function facts(over: Partial<PromptFacts> = {}): PromptFacts {
  return {
    mode: 'balanced',
    autopilot: 'off',
    suggestions: true,
    prompt: LIGHT,
    prevPrompt: '',
    isFirstPrompt: true,
    marker: null,
    explicitNew: false,
    mainCache: undefined,
    now: NOW,
    current: { model: OPUS, effort: 'high' },
    contextTokens: 0,
    dismissed: [],
    shown: [],
    ...over,
  };
}

describe('detectTaskStart (spec §4.4)', () => {
  const base = { isFirstPrompt: false, marker: null, explicitNew: false, now: NOW };
  it('first prompt, /clear and compaction are free clean points with an empty context', () => {
    expect(detectTaskStart({ ...base, isFirstPrompt: true, mainCache: undefined })).toEqual({ reason: 'first-prompt', freeSwitch: true, contextTokens: 0 });
    expect(detectTaskStart({ ...base, marker: 'clear', mainCache: warm(90_000) })).toEqual({ reason: 'clear', freeSwitch: true, contextTokens: 0 });
    expect(detectTaskStart({ ...base, marker: 'compact', mainCache: warm(90_000) })?.contextTokens).toBe(0);
  });
  it('an idle main line (past the TTL less the margin) is a start, and keeps its context size', () => {
    const cold = warm(120_000, 5 * 60_000 - 20_000); // 4m40s: inside the 30 s margin before the 5m TTL
    expect(detectTaskStart({ ...base, mainCache: cold })).toEqual({ reason: 'idle', freeSwitch: true, contextTokens: 120_000 });
    expect(detectTaskStart({ ...base, mainCache: warm(120_000, 4 * 60_000) })).toBeNull();
  });
  it('a 1h cache is warm for far longer', () => {
    expect(detectTaskStart({ ...base, mainCache: { ...warm(50_000, 20 * 60_000), ttl: '1h' } })).toBeNull();
  });
  it('an explicit /agento new on a warm cache starts a task but is not free', () => {
    expect(detectTaskStart({ ...base, explicitNew: true, mainCache: warm(90_000) })).toEqual({ reason: 'explicit', freeSwitch: false, contextTokens: 90_000 });
    expect(detectTaskStart({ ...base, explicitNew: true, mainCache: warm(90_000, 6 * 60_000) })?.reason).toBe('idle');
  });
  it('a mid-task prompt is no start', () => {
    expect(detectTaskStart({ ...base, mainCache: warm(30_000) })).toBeNull();
  });
});

describe('downgradeFor: only ever downward (P3)', () => {
  it('moves to a cheaper tier and a lower effort', () => {
    expect(downgradeFor({ model: OPUS, effort: 'max' }, { tier: 'sonnet', effort: 'medium' })).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(downgradeFor({ model: FABLE, effort: null }, { tier: 'opus', effort: 'high' })).toEqual({ model: 'opus' });
  });
  it('effort alone', () => {
    expect(downgradeFor({ model: SONNET, effort: 'xhigh' }, { tier: 'sonnet', effort: 'medium' })).toEqual({ effort: 'medium' });
  });
  it('never raises a model or an effort', () => {
    expect(downgradeFor({ model: SONNET, effort: 'low' }, { tier: 'opus', effort: 'high' })).toBeNull();
    expect(downgradeFor({ model: 'claude-haiku-4-5', effort: 'medium' }, { tier: 'sonnet', effort: 'medium' })).toBeNull();
  });
  it('an unknown model or effort is left alone', () => {
    expect(downgradeFor({ model: 'gateway-x', effort: null }, { tier: 'haiku', effort: 'low' })).toBeNull();
    expect(downgradeFor({ model: OPUS, effort: 'turbo' }, { tier: 'opus', effort: 'high' })).toBeNull();
  });
});

describe('decidePrompt', () => {
  it('first prompt, light task on opus: S1 to sonnet·medium', () => {
    const d = decidePrompt(facts());
    expect(d.start?.reason).toBe('first-prompt');
    expect(d.verdict).toMatchObject({ tier: 'sonnet', effort: 'medium', confidence: 0.7 });
    expect(d.action).toEqual({ kind: 'S1', down: { model: 'sonnet', effort: 'medium' } });
  });

  it('no S1 when the current setup is already at or below the verdict', () => {
    expect(decidePrompt(facts({ current: { model: SONNET, effort: 'medium' } })).action.kind).toBe('none');
  });

  it('threshold: heavy 0.6 is below balanced 0.65 and above eco 0.55', () => {
    expect(confidenceThreshold('balanced')).toBe(0.65);
    expect(confidenceThreshold('eco')).toBe(0.55);
    const heavyOnFable = { prompt: HEAVY, current: { model: FABLE, effort: 'high' } };
    expect(decidePrompt(facts(heavyOnFable)).action.kind).toBe('none');
    expect(decidePrompt(facts({ ...heavyOnFable, mode: 'eco' })).action).toEqual({ kind: 'S1', down: { model: 'opus' } });
  });

  it('quality and off never suggest a model', () => {
    expect(decidePrompt(facts({ mode: 'quality' })).action.kind).toBe('none');
    expect(decidePrompt(facts({ mode: 'off' })).action.kind).toBe('none');
    expect(decidePrompt(facts({ mode: 'quality', autopilot: 'clean-points' })).action.kind).toBe('none');
  });

  it('suggestions off: no banners, but autopilot still acts at a clean point', () => {
    expect(decidePrompt(facts({ suggestions: false })).action.kind).toBe('none');
    expect(decidePrompt(facts({ suggestions: false, autopilot: 'clean-points' })).action.kind).toBe('autopilot');
  });

  it('"don\'t suggest" and "already shown for this task" silence S1', () => {
    expect(decidePrompt(facts({ dismissed: ['S1'] })).action.kind).toBe('none');
    expect(decidePrompt(facts({ shown: ['S1'] })).action.kind).toBe('none');
  });

  it('warm long context and a new topic: S4, never S1 (not a clean point)', () => {
    const d = decidePrompt(facts({ isFirstPrompt: false, mainCache: warm(120_000), contextTokens: 120_000, prevPrompt: 'Поправь парсер конфигурации YAML и добавь валидацию схемы', prompt: 'Напиши миграцию базы данных для таблицы заказов и индексы' }));
    expect(d.start).toBeNull();
    expect(d.action).toMatchObject({ kind: 'S4', why: 'topic-shift' });
    expect((d.action as { shift: number }).shift).toBeGreaterThanOrEqual(0.85);
  });

  it('same topic in a long warm context: nothing', () => {
    const p = 'Поправь парсер конфигурации YAML и добавь валидацию схемы';
    expect(decidePrompt(facts({ isFirstPrompt: false, mainCache: warm(120_000), contextTokens: 120_000, prevPrompt: p, prompt: `${p} ещё и для JSON` })).action.kind).toBe('none');
  });

  it('a topic shift in a short context is not worth a /clear', () => {
    const d = decidePrompt(facts({ isFirstPrompt: false, mainCache: warm(30_000), contextTokens: 30_000, prevPrompt: 'Поправь парсер конфигурации YAML и добавь валидацию схемы', prompt: 'Напиши миграцию базы данных для таблицы заказов и индексы' }));
    expect(d.action.kind).toBe('none');
  });

  it('an oversized context (> 150k) gets S4 without a topic shift, once per task', () => {
    const f = facts({ isFirstPrompt: false, mainCache: warm(160_000), contextTokens: 160_000, prevPrompt: 'a', prompt: 'b' });
    expect(decidePrompt(f).action).toMatchObject({ kind: 'S4', why: 'big-context' });
    expect(decidePrompt({ ...f, shown: ['S4'] }).action.kind).toBe('none');
    expect(decidePrompt({ ...f, dismissed: ['S4'] }).action.kind).toBe('none');
  });

  it('after idle: a clean point again, S1 allowed even with a big old context', () => {
    const d = decidePrompt(facts({ isFirstPrompt: false, mainCache: warm(120_000, 10 * 60_000), contextTokens: 120_000 }));
    expect(d.start?.reason).toBe('idle');
    expect(d.action.kind).toBe('S1');
  });

  it('/agento new on a warm 120k context: S4 (clear first), not S1', () => {
    const d = decidePrompt(facts({ isFirstPrompt: false, explicitNew: true, mainCache: warm(120_000), contextTokens: 120_000 }));
    expect(d.action).toMatchObject({ kind: 'S4', why: 'new-task' });
  });

  it('/agento new on a small warm context: S1 allowed, autopilot not (the switch is not free)', () => {
    const f = facts({ isFirstPrompt: false, explicitNew: true, mainCache: warm(20_000), contextTokens: 20_000 });
    expect(decidePrompt(f).action.kind).toBe('S1');
    expect(decidePrompt({ ...f, autopilot: 'clean-points' }).action.kind).toBe('S1');
  });

  it('autopilot at a free clean point', () => {
    expect(decidePrompt(facts({ autopilot: 'clean-points' })).action).toEqual({ kind: 'autopilot', down: { model: 'sonnet', effort: 'medium' } });
    expect(decidePrompt(facts({ autopilot: 'clean-points', isFirstPrompt: false, marker: 'clear', mainCache: warm(80_000) })).action.kind).toBe('autopilot');
  });

  it('autopilot never acts mid-task', () => {
    const d = decidePrompt(facts({ autopilot: 'clean-points', isFirstPrompt: false, mainCache: warm(30_000), contextTokens: 30_000 }));
    expect(d.start).toBeNull();
    expect(d.action.kind).toBe('none');
  });

  it('autopilot is held back below the confidence threshold', () => {
    expect(decidePrompt(facts({ autopilot: 'clean-points', prompt: 'Сделай что-нибудь с кодом в проекте, как считаешь нужным' })).action.kind).toBe('none');
  });

  it('autopilot never raises: sonnet user with a heavy task gets the S2 conversation starter, not a model change', () => {
    const d = decidePrompt(facts({ autopilot: 'clean-points', prompt: HEAVY, current: { model: SONNET, effort: 'medium' } }));
    expect(d.action.kind).toBe('S2a');
  });

  it('S2a: heavy or planning work on sonnet/haiku at a clean point; not on opus; silenced by "don\'t suggest"', () => {
    expect(decidePrompt(facts({ prompt: HEAVY, current: { model: SONNET, effort: 'high' } })).action).toEqual({ kind: 'S2a' });
    expect(decidePrompt(facts({ prompt: 'Давай обсудим подход к кэшированию', current: { model: 'claude-haiku-4-5', effort: null } })).action.kind).toBe('S2a');
    expect(decidePrompt(facts({ prompt: HEAVY, current: { model: OPUS, effort: 'high' } })).action.kind).toBe('none');
    expect(decidePrompt(facts({ prompt: HEAVY, current: { model: SONNET, effort: 'high' }, dismissed: ['S2'] })).action.kind).toBe('none');
    expect(decidePrompt(facts({ prompt: HEAVY, current: { model: SONNET, effort: 'high' }, mode: 'quality' })).action.kind).toBe('none');
  });
});

describe('banner priority: S7 > S2 > S1 > S4', () => {
  it('a banner is replaced by the same or a higher priority only', () => {
    expect(canReplace(undefined, 'S4')).toBe(true);
    expect(canReplace('S4', 'S1')).toBe(true);
    expect(canReplace('S1', 'S4')).toBe(false);
    expect(canReplace('S1', 'S2a')).toBe(true);
    expect(canReplace('S2b', 'S1')).toBe(false);
    expect(canReplace('S2a', 'S2b')).toBe(true);
    expect(canReplace('S2a', 'S7')).toBe(true);
    expect(canReplace('S7', 'S2b')).toBe(false);
    expect(canReplace('S7', 'S7')).toBe(true);
  });
  it('the autopilot notice outranks S1 and yields to S2', () => {
    expect(canReplace('S1', 'AP')).toBe(true);
    expect(canReplace('AP', 'S1')).toBe(false);
    expect(canReplace('AP', 'S2a')).toBe(true);
  });
  it('"don\'t suggest" keys: one per scenario, both handoff banners share S2, S7 has none', () => {
    expect(dismissKeyOf('S1')).toBe('S1');
    expect(dismissKeyOf('S2a')).toBe('S2');
    expect(dismissKeyOf('S2b')).toBe('S2');
    expect(dismissKeyOf('S4')).toBe('S4');
    expect(dismissKeyOf('S7')).toBeNull();
    expect(dismissKeyOf('AP')).toBeNull();
  });
});

describe('autopilot override: the clean-point task\'s requests', () => {
  const ov = makeOverride({ model: 'sonnet', effort: 'medium' }, { model: OPUS, effort: 'high' }, NOW);

  it('names the target by exact id, and remembers what the user had', () => {
    expect(ov).toEqual({ model: 'sonnet', modelId: SONNET, effort: 'medium', fromModel: OPUS, fromEffort: 'high', persisted: false, since: NOW });
    expect(makeOverride({ effort: 'low' }, { model: OPUS, effort: 'max' }, NOW)).toEqual({ effort: 'low', fromModel: OPUS, fromEffort: 'max', persisted: false, since: NOW });
  });

  it('no override for a model whose target id is not ours to guess', () => {
    expect(makeOverride({ model: 'sonnet' }, { model: 'us.anthropic.claude-opus-5-5-v1:0', effort: null }, NOW)).toBeNull();
    expect(makeOverride({ model: 'sonnet' }, { model: 'claude-opus-5-5[1m]', effort: null }, NOW)).toBeNull();
    expect(makeOverride({ model: 'sonnet' }, { model: 'gateway-x', effort: null }, NOW)).toBeNull();
  });

  it('rewrites a request only downward (P3)', () => {
    expect(overrideFor(ov!, { model: OPUS, effort: 'high' })).toEqual({ model: SONNET, effort: 'medium' });
    expect(overrideFor(ov!, { model: OPUS, effort: 'medium' })).toEqual({ model: SONNET });
    // the user already is on sonnet·low: nothing to do, and never raised to medium
    expect(overrideFor(ov!, { model: SONNET, effort: 'low' })).toBeNull();
    expect(overrideFor(ov!, { model: 'claude-haiku-4-5', effort: 'low' })).toBeNull();
    expect(overrideFor(ov!, { model: SONNET })).toBeNull();
  });

  it('a numeric effort or an unknown model is left alone', () => {
    expect(overrideFor(ov!, { model: 'gateway-x', effort: 4000 })).toBeNull();
  });

  it('once persisted, nothing is rewritten', () => {
    expect(overrideFor({ ...ov!, persisted: true }, { model: OPUS, effort: 'high' })).toBeNull();
  });

  it('tier ids', () => {
    expect(modelIdForTier('sonnet', 'claude-opus-5-5')).toBe('claude-sonnet-5-5');
    expect(modelIdForTier('opus', 'claude-fable-5-1')).toBe('claude-opus-5-5');
    expect(modelIdForTier('sonnet', 'claude-opus-4-8-20260101')).toBe('claude-sonnet-5-5');
    expect(modelIdForTier('sonnet', 'opus')).toBeNull();
  });
});
