import { describe, expect, it } from 'vitest';
import { fitPctPerUsd, pctOf, recordStep, MAX_POINTS, type CalibrationState } from './calibration.ts';

const WEEK = '2026-10-12T00:00:00Z';

function feed(state: CalibrationState | undefined, resetsAt: string, steps: Array<[usd: number, pct: number | null]>): CalibrationState {
  let s = state;
  for (const [usd, pct] of steps) s = recordStep(s, resetsAt, usd, pct);
  return s as CalibrationState;
}

describe('calibration (spec §7.8)', () => {
  it('fits percent per dollar from (cumulative dollars, percent) pairs of one window', () => {
    // 2 % of the weekly limit per dollar, on top of 10 % used elsewhere.
    const s = feed(undefined, WEEK, [[0.5, 11], [0.5, 12], [0.5, 13], [0.5, 14], [0.5, 15], [0.5, 16]]);
    expect(fitPctPerUsd(s)).toBeCloseTo(2, 6);
  });

  it('a percent that did not move records no point', () => {
    const s = feed(undefined, WEEK, [[1, 10], [1, 10], [1, 10]]);
    expect(s.windows[0]?.points).toHaveLength(1);
    expect(s.windows[0]?.usd).toBe(3);
  });

  it('too little evidence: no fit, so no percent is shown', () => {
    expect(fitPctPerUsd(undefined)).toBeNull();
    expect(fitPctPerUsd(feed(undefined, WEEK, [[0.5, 11], [0.5, 12]]))).toBeNull();
    // enough points but the dollars barely moved
    expect(fitPctPerUsd(feed(undefined, WEEK, [[0.01, 11], [0.01, 12], [0.01, 13], [0.01, 14], [0.01, 15]]))).toBeNull();
    // percent flat
    expect(fitPctPerUsd(feed(undefined, WEEK, [[1, 5], [1, 5], [1, 5], [1, 5], [1, 5], [1, 5]]))).toBeNull();
  });

  it('windows are kept apart: each is centred on its own, then pooled', () => {
    let s = feed(undefined, WEEK, [[1, 5], [1, 7], [1, 9]]);
    s = feed(s, '2026-10-19T00:00:00Z', [[1, 40], [1, 42], [1, 44]]);
    expect(fitPctPerUsd(s)).toBeCloseTo(2, 6);
  });

  it('a step without a reading still adds its dollars', () => {
    const s = feed(undefined, WEEK, [[1, null], [1, 4], [1, 6]]);
    expect(s.windows[0]?.usd).toBe(3);
    expect(s.windows[0]?.points).toEqual([{ usd: 2, pct: 4 }, { usd: 3, pct: 6 }]);
  });

  it('bounded: points per window and windows kept', () => {
    const many = Array.from({ length: MAX_POINTS + 30 }, (_, i): [number, number] => [0.1, i + 1]);
    expect(feed(undefined, WEEK, many).windows[0]?.points).toHaveLength(MAX_POINTS);
    let s: CalibrationState | undefined;
    for (let w = 0; w < 7; w++) s = feed(s, `w${w}`, [[1, 1]]);
    expect(s?.windows).toHaveLength(4);
  });

  it('survives junk in the store', () => {
    expect(recordStep('junk', WEEK, 1, 3).windows).toHaveLength(1);
  });

  it('pctOf', () => {
    expect(pctOf(0.3, 2)).toBeCloseTo(0.6, 9);
    expect(pctOf(0.3, null)).toBeNull();
  });
});
