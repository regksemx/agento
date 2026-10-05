import { describe, expect, it } from 'vitest';
import { familyOf, tierOf, PRICES } from './pricing.ts';
import { costOf, repriceAs, normalizeUsage, cacheWriteSplit } from './cost.ts';
import { isWarm, switchPenalty, rewriteCost, type LineageState } from './cache.ts';

describe('familyOf', () => {
  it.each([
    ['claude-opus-5-5', 'opus-5.5'],
    ['claude-opus-5-5-20260801', 'opus-5.5'],
    ['claude-opus-5', 'opus-5'],
    ['claude-opus-5-20260301', 'opus-5'],
    ['claude-opus-4-8', 'opus-4.x'],
    ['claude-opus-4-6[1m]', 'opus-4.x'],
    ['claude-sonnet-5-5', 'sonnet-5.5'],
    ['claude-sonnet-5', 'sonnet-5'],
    ['claude-sonnet-4-6', 'sonnet-4.x'],
    ['claude-haiku-4-5-20251001', 'haiku-4.5'],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'haiku-4.5'],
    ['claude-fable-5-1', 'fable-5.1'],
    ['claude-fable-5', 'fable-5'],
    ['claude-mythos-5-1', 'fable-5.1'],
    ['opus', 'opus-5.5'],
    ['sonnet', 'sonnet-5.5'],
    ['haiku', 'haiku-4.5'],
    ['<synthetic>', 'unknown'],
    ['', 'unknown'],
    ['gpt-5', 'unknown'],
  ])('%s → %s', (id, family) => expect(familyOf(id)).toBe(family));

  it('tiers', () => {
    expect(tierOf('claude-opus-5-5')).toBe('opus');
    expect(tierOf('claude-fable-5-1')).toBe('fable');
    expect(tierOf('<synthetic>')).toBeNull();
  });
});

describe('costOf', () => {
  const step = normalizeUsage({
    input_tokens: 0,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 3_000,
    output_tokens: 1_500,
  });

  it('matches the reference step from docs/spec-phase-0-1.md §5.2', () => {
    expect(costOf('claude-opus-5-5', step)!.total).toBeCloseTo(0.065, 9);
    expect(costOf('claude-sonnet-5-5', step)!.total).toBeCloseTo(0.0425, 9);
    expect(costOf('claude-haiku-4-5', step)!.total).toBeCloseTo(0.02125, 9);
  });

  it('prices 1h writes at the 1h rate', () => {
    const u = normalizeUsage({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } });
    expect(costOf('claude-opus-5-5', u)!.cacheWrite).toBeCloseTo(PRICES['opus-5.5'].write1h, 9);
  });

  it('bills an unexplained remainder of cache writes at 5m', () => {
    const u = normalizeUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 50 } });
    expect(cacheWriteSplit(u)).toEqual({ w5m: 70, w1h: 30 });
  });

  it('doubles fast mode', () => {
    const u = normalizeUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000, speed: 'fast' });
    expect(costOf('claude-opus-5-5', u)!.total).toBeCloseTo(8 + 40, 9);
  });

  it('returns null for unknown models and drops fast mode when repricing', () => {
    expect(costOf('<synthetic>', step)).toBeNull();
    const u = normalizeUsage({ output_tokens: 1_000_000, speed: 'fast' });
    expect(repriceAs('sonnet', u)!.total).toBeCloseTo(10, 9);
  });

  it('treats garbage usage fields as zero', () => {
    const u = normalizeUsage({ input_tokens: -5, output_tokens: Number.NaN } as never);
    expect(costOf('opus', u)!.total).toBe(0);
  });
});

describe('cache', () => {
  const now = 10 * 60_000;
  const warm: LineageState = { model: 'claude-opus-5-5', prefixTokens: 100_000, lastAt: now - 60_000, ttl: '5m' };

  it('warm/cold around the TTL with a safety margin', () => {
    expect(isWarm(warm, now)).toBe(true);
    expect(isWarm({ ...warm, lastAt: now - 4.6 * 60_000 }, now)).toBe(false);
    expect(isWarm({ ...warm, ttl: '1h', lastAt: now - 30 * 60_000 }, now)).toBe(true);
  });

  it('reproduces the Opus→Sonnet switch penalty from spec §1 (+$0.23)', () => {
    expect(switchPenalty(warm, 'sonnet', now)).toBeCloseTo(0.25 - 0.02, 9);
  });

  it('a cold switch only costs the write price difference', () => {
    const cold = { ...warm, lastAt: 0 };
    expect(switchPenalty(cold, 'sonnet', now)).toBeCloseTo(0.25 - 0.5, 9);
    expect(rewriteCost('opus', 100_000, '1h')).toBeCloseTo(0.8, 9);
  });
});
