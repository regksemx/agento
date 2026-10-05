import { describe, expect, it } from 'vitest';
import { quantile, simulateSwitches } from '../src/audit/switch-sim.ts';
import { MIN, T0, call, corpus, session } from './corpus-builder.ts';

// 97k read + 3k fresh = 100k prefix, 1.5k output.
const typical = (i: number, p = {}) => call({ ts: T0 + i * MIN, usage: { cache_read_input_tokens: 97_000, cache_creation_input_tokens: 3_000, output_tokens: 1_500 }, ...p });
const row = (rows: ReturnType<typeof simulateSwitches>['rows'], from: string, to: string, prefix?: number) =>
  rows.find((r) => r.from === from && r.to === to && (prefix === undefined || r.prefixTokens === prefix))!;

describe('quantile', () => {
  it('uses nearest rank', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('simulateSwitches', () => {
  it('is empty without main calls', () => {
    expect(simulateSwitches(corpus([])).rows).toEqual([]);
    expect(simulateSwitches(corpus([session({ calls: [typical(0, { lineage: 'agent:a' })] })])).rows).toEqual([]);
  });

  it('reproduces the spec numbers for a 100k prefix opus-5.5 -> sonnet-5.5', () => {
    const r = simulateSwitches(corpus([session({ calls: [typical(0), typical(1), typical(2)] })]));
    expect(r.rows).toHaveLength(8); // 4 pairs x (median, p90)
    const x = row(r.rows, 'opus-5.5', 'sonnet-5.5', 100_000);
    expect(x.penalty).toBeCloseTo(0.23, 10);
    // 3k * ($5 - $2.5) + 1.5k * ($20 - $10), reads cost the same
    expect(x.savingPerStep).toBeCloseTo(0.0225, 10);
    expect(x.breakEvenSteps).toBe(11); // ceil of 10.22
  });

  it('computes the other pairs', () => {
    const r = simulateSwitches(corpus([session({ calls: [typical(0), typical(1), typical(2)] })]));
    const haiku = row(r.rows, 'opus-5.5', 'haiku-4.5', 100_000);
    expect(haiku.penalty).toBeCloseTo(0.105, 10); // 100k * $1.25 - 100k * $0.20
    expect(haiku.savingPerStep).toBeCloseTo(0.065 - 0.02125, 10);
    const fable = row(r.rows, 'fable-5.1', 'opus-5.5', 100_000);
    expect(fable.penalty).toBeCloseTo(0.475, 10); // 100k * $5 - 100k * $0.25
    expect(fable.savingPerStep).toBeCloseTo(0.1375 - 0.065, 10);
    const old = row(r.rows, 'opus-5', 'sonnet-5.5', 100_000);
    expect(old.penalty).toBeCloseTo(0.2, 10); // 100k * $2.5 - 100k * $0.5
    // opus-5 reads cost $0.50: 97k * 0.3 extra on top of the opus-5.5 saving
    expect(old.savingPerStep).toBeGreaterThan(row(r.rows, 'opus-5.5', 'sonnet-5.5', 100_000).savingPerStep);
  });

  it('adds median and p90 rows from the prefix distribution', () => {
    const sizes = [20_000, 20_000, 40_000, 60_000, 60_000, 80_000, 100_000, 120_000, 150_000, 300_000];
    const calls = sizes.map((n, i) => call({ ts: T0 + i * MIN, usage: { cache_read_input_tokens: n - 3_000, cache_creation_input_tokens: 3_000, output_tokens: 1_500 } }));
    const r = simulateSwitches(corpus([session({ calls })]));
    const prefixes = [...new Set(r.rows.map((x) => x.prefixTokens))];
    expect(prefixes).toEqual([60_000, 150_000]);
    // penalty scales with the prefix, saving per step does not
    const med = row(r.rows, 'opus-5.5', 'sonnet-5.5', 60_000);
    const p90 = row(r.rows, 'opus-5.5', 'sonnet-5.5', 150_000);
    expect(p90.penalty).toBeCloseTo(med.penalty * 2.5, 10);
    expect(p90.savingPerStep).toBeCloseTo(med.savingPerStep, 10);
  });

  it('reports null break-even when the target is not cheaper per step', () => {
    // no fresh writes and no output: only reads, which fable-5.1 -> opus-5.5 does cheaper; opus-5.5 -> sonnet-5.5 does not
    const calls = [call({ ts: T0, usage: { cache_read_input_tokens: 100_000 } })];
    const r = simulateSwitches(corpus([session({ calls })]));
    expect(row(r.rows, 'opus-5.5', 'sonnet-5.5').breakEvenSteps).toBeNull();
    expect(row(r.rows, 'fable-5.1', 'opus-5.5').breakEvenSteps).not.toBeNull();
  });
});
