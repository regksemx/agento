import { describe, expect, it } from 'vitest';
import { type ClassStats, averageCost, classOf, DEFAULT_TASK_STEPS, estimateSaving, foldClassStats, handoffSaving, readCostPerStep, stepSaving, MIN_CLASS_TASKS } from './estimate.ts';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

describe('stepSaving: the reference step of spec §1', () => {
  it('opus 5.5 → sonnet 5.5 saves ≈ $0.0225 a step', () => {
    expect(stepSaving(OPUS, SONNET)).toBeCloseTo(0.065 - 0.0425, 9);
  });
  it('is null for an unknown model, negative upward', () => {
    expect(stepSaving('gateway-x', SONNET)).toBeNull();
    expect(stepSaving(SONNET, OPUS)).toBeLessThan(0);
  });
});

describe('classOf', () => {
  it('maps a verdict to light / default / heavy', () => {
    expect(classOf({ tier: 'sonnet', effort: 'medium' })).toBe('light');
    expect(classOf({ tier: 'sonnet', effort: 'high' })).toBe('default');
    expect(classOf({ tier: 'opus', effort: 'high' })).toBe('heavy');
  });
});

describe('estimateSaving', () => {
  it('nothing recorded: the class\'s typical step count times the reference saving', () => {
    const s = estimateSaving('light', OPUS, SONNET, undefined);
    expect(s?.basis).toBe('default');
    expect(s?.usd).toBeCloseTo(DEFAULT_TASK_STEPS.light * 0.0225, 9);
  });

  it('only the current tier has history: its average scaled by the price ratio', () => {
    let stats: ClassStats = { byTier: {} };
    for (let i = 0; i < MIN_CLASS_TASKS; i++) stats = foldClassStats(stats, 'opus', 0.65, 10);
    const s = estimateSaving('light', OPUS, SONNET, stats);
    expect(s?.basis).toBe('ratio');
    expect(s?.usd).toBeCloseTo(0.65 * (0.0225 / 0.065), 9);
  });

  it('both tiers have history: the difference of the averages', () => {
    let stats: ClassStats = { byTier: {} };
    for (let i = 0; i < 4; i++) stats = foldClassStats(stats, 'opus', 0.8, 10);
    for (let i = 0; i < 3; i++) stats = foldClassStats(stats, 'sonnet', 0.5, 10);
    expect(estimateSaving('light', OPUS, SONNET, stats)).toEqual({ usd: expect.closeTo(0.3, 9), basis: 'history' });
  });

  it('too few tasks do not count as history', () => {
    const stats = foldClassStats(foldClassStats(undefined, 'opus', 0.9, 9), 'opus', 0.9, 9);
    expect(averageCost(stats, 'opus')).toBeNull();
    expect(estimateSaving('light', OPUS, SONNET, stats)?.basis).toBe('default');
  });

  it('no estimate for an unknown price or a move that saves nothing', () => {
    expect(estimateSaving('light', 'gateway-x', SONNET, undefined)).toBeNull();
    expect(estimateSaving('light', SONNET, OPUS, undefined)).toBeNull();
  });
});

describe('foldClassStats', () => {
  it('keeps tiers apart and tolerates junk', () => {
    const a = foldClassStats('junk', 'opus', 1, 5);
    const b = foldClassStats(a, 'sonnet', 0.5, 4);
    expect(b.byTier.opus).toEqual({ tasks: 1, cost: 1, steps: 5 });
    expect(b.byTier.sonnet).toEqual({ tasks: 1, cost: 0.5, steps: 4 });
  });
});

describe('readCostPerStep (S4)', () => {
  it('120k of context read on opus 5.5 is ≈ $0.024 a step', () => {
    expect(readCostPerStep(OPUS, 120_000)).toBeCloseTo(0.024, 9);
    expect(readCostPerStep('gateway-x', 120_000)).toBeNull();
  });
});

describe('handoffSaving', () => {
  it('a clean 8k sonnet context against a 140k opus planning context', () => {
    const usd = handoffSaving(OPUS, SONNET, 140_000, 15);
    expect(usd).not.toBeNull();
    // per step: price 0.0225 + read 140k*0.2 − 8k*0.2 = 0.0264 → 0.0489; ×15 less the 8k write at $2.5/M
    expect(usd).toBeCloseTo(15 * (0.0225 + 0.0264) - 0.02, 6);
  });
  it('nothing to gain: null', () => {
    expect(handoffSaving(SONNET, SONNET, 4000, 15)).toBeNull();
    expect(handoffSaving('gateway-x', SONNET, 100_000, 15)).toBeNull();
  });
});
