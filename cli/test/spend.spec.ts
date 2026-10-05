import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { costOf } from '../../plugin/core/cost.ts';
import { analyzeSpend, callCost, reconcile, sessionCost } from '../src/audit/spend.ts';
import { call, corpus, session } from './corpus-builder.ts';

const local = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 4000 };

describe('analyzeSpend', () => {
  const calls = [
    call({ ts: local(2026, 9, 1), model: 'claude-opus-5-5', usage, effort: 'high', project: 'a', sessionId: 's1' }),
    call({ ts: local(2026, 9, 1, 13), model: 'claude-sonnet-5-5', usage, effort: 'medium', project: 'a', sessionId: 's1' }),
    call({ ts: local(2026, 9, 1, 14), model: 'claude-haiku-4-5-20251001', usage, lineage: 'agent:x', project: 'a', sessionId: 's1' }),
    call({ ts: local(2026, 9, 4), model: 'claude-opus-5-5', usage, effort: 'high', project: 'b', sessionId: 's2' }),
  ];
  const c = corpus([session({ sessionId: 's1', calls: calls.slice(0, 3) }), session({ sessionId: 's2', calls: calls.slice(3) })]);
  const spend = analyzeSpend(c);
  const expected = (m: string): number => costOf(m, usage)!.total;

  it('buckets sum to the sum of costOf', () => {
    const total = 2 * expected('claude-opus-5-5') + expected('claude-sonnet-5-5') + expected('claude-haiku-4-5');
    expect(spend.total.total).toBeCloseTo(total, 10);
    const t = spend.total;
    expect(t.input + t.cacheWrite + t.cacheRead + t.output).toBeCloseTo(t.total, 10);
    expect(spend.main.total + spend.subagents.total).toBeCloseTo(t.total, 10);
    expect(spend.subagents.total).toBeCloseTo(expected('claude-haiku-4-5'), 10);
  });

  it('groups by family, most expensive first', () => {
    expect(spend.byFamily.map((f) => [f.family, f.calls])).toEqual([
      ['opus-5.5', 2],
      ['sonnet-5.5', 1],
      ['haiku-4.5', 1],
    ]);
    expect(spend.byFamily[0]!.cost.total).toBeCloseTo(2 * expected('claude-opus-5-5'), 10);
  });

  it('groups by project and effort', () => {
    expect(spend.byProject.map((p) => [p.project, p.sessions])).toEqual([['a', 1], ['b', 1]]);
    expect(spend.byProject.find((p) => p.project === 'b')!.cost).toBeCloseTo(expected('claude-opus-5-5'), 10);
    expect(spend.effortMix.find((e) => e.effort === 'high')).toMatchObject({ calls: 2 });
    expect(spend.effortMix.find((e) => e.effort === 'unknown')).toMatchObject({ calls: 1 });
  });

  it('labels projects by the most common session cwd, home as ~, else the decoded dir name', () => {
    const home = homedir();
    const mk = (sessionId: string, project: string, cwd: string | undefined) =>
      session({ sessionId, project, cwd, calls: [call({ sessionId, project, usage })] });
    const s = analyzeSpend(
      corpus([
        mk('1', '-Users-x-Projects-app', join(home, 'Projects', 'app')),
        mk('2', '-Users-x-Projects-app', join(home, 'Projects', 'app')),
        mk('3', '-Users-x-Projects-app', '/tmp/elsewhere'), // minority cwd loses
        mk('4', '-opt-svc-api', '/opt/svc/api'), // outside home: kept as is
        mk('5', `${homedir().replace(/\//g, '-')}-Projects-fallback`, undefined), // no cwd: decoded from the dir name
        mk('6', 'plain', undefined),
      ]),
    );
    expect(s.byProject.map((p) => [p.project, p.sessions]).sort()).toEqual(
      [['~/Projects/app', 3], ['/opt/svc/api', 1], ['~/Projects/fallback', 1], ['plain', 1]].sort(),
    );
  });

  it('merges project directories that share a cwd', () => {
    const mk = (sessionId: string, project: string) => session({ sessionId, project, cwd: '/w/app', calls: [call({ sessionId, project, usage })] });
    const s = analyzeSpend(corpus([mk('1', '-w-app'), mk('2', '-w-app-wt')]));
    expect(s.byProject).toHaveLength(1);
    expect(s.byProject[0]).toMatchObject({ project: '/w/app', sessions: 2 });
  });

  it('fills gaps in days and weeks, local time, ascending', () => {
    expect(spend.byDay.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    expect(spend.byDay[1]!.cost).toBe(0);
    expect(spend.byDay[0]!.cost).toBeCloseTo(expected('claude-opus-5-5') + expected('claude-sonnet-5-5') + expected('claude-haiku-4-5'), 10);
    expect(spend.byDay.reduce((n, d) => n + d.cost, 0)).toBeCloseTo(spend.total.total, 10);
    // 2026-09-01 is a Tuesday: the week starts on Monday 2026-08-31, the next one on 09-07
    expect(spend.byWeek.map((w) => w.weekStart)).toEqual(['2026-08-31']);
  });

  it('assigns calls to days by local midnight, not UTC', () => {
    const s = analyzeSpend(corpus([session({ calls: [call({ ts: local(2026, 9, 1, 23, 30), usage }), call({ ts: local(2026, 9, 2, 0, 30), usage })] })]));
    expect(s.byDay.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02']);
    expect(s.byDay.every((d) => d.cost > 0)).toBe(true);
  });

  it('fills empty weeks between distant days', () => {
    const s = analyzeSpend(corpus([session({ calls: [call({ ts: local(2026, 9, 1), usage }), call({ ts: local(2026, 9, 16), usage })] })]));
    expect(s.byWeek.map((w) => w.weekStart)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
    expect(s.byWeek[1]!.cost).toBe(0);
    expect(s.byDay).toHaveLength(16);
  });

  it('prices fast mode and reports its share', () => {
    const slow = call({ usage });
    const fast = call({ usage, speed: 'fast' });
    expect(callCost(fast)!.total).toBeGreaterThan(callCost(slow)!.total);
    const s = analyzeSpend(corpus([session({ calls: [slow, fast] })]));
    expect(s.fastModeCost).toBeCloseTo(callCost(fast)!.total, 10);
    expect(s.total.total).toBeCloseTo(callCost(fast)!.total + callCost(slow)!.total, 10);
  });

  it('counts unknown models without pricing them', () => {
    const s = analyzeSpend(corpus([session({ calls: [call({ model: 'claude-mystery-9', usage }), call({ usage })] })]));
    expect(s.byFamily.find((f) => f.family === 'unknown')).toMatchObject({ calls: 1, cost: { total: 0 } });
    expect(s.total.total).toBeCloseTo(expected('claude-opus-5-5'), 10);
  });

  it('is empty-safe', () => {
    const s = analyzeSpend(corpus([]));
    expect(s.total.total).toBe(0);
    expect(s.byDay).toEqual([]);
    expect(s.byWeek).toEqual([]);
    expect(s.reconciliation).toEqual({ sessionsChecked: 0, withinTolerance: 0, medianDeviation: 0, worstDeviation: 0 });
  });
});

describe('reconcile', () => {
  const mk = (reported: number | undefined): ReturnType<typeof session> => session({ calls: [call({ usage })], reportedCostUSD: reported });
  const base = sessionCost(mk(undefined));

  it('counts sessions within +-10% of the reported cost', () => {
    const r = reconcile([mk(base), mk(base * 1.05), mk(base / 0.95), mk(base * 2), mk(undefined), mk(0)]);
    expect(r.sessionsChecked).toBe(4);
    expect(r.withinTolerance).toBe(3);
    expect(r.worstDeviation).toBeCloseTo(0.5, 6); // |base - 2 base| / (2 base)
  });

  it('ignores sessions whose reported cost is under $0.05', () => {
    const tiny = session({ calls: [call({ usage: { input_tokens: 1000 } })], reportedCostUSD: 0.0001 });
    const below = session({ calls: [call({ usage })], reportedCostUSD: 0.049 });
    const r = reconcile([tiny, below, mk(base)]);
    expect(r.sessionsChecked).toBe(1);
    expect(r.worstDeviation).toBeCloseTo(0, 10);
    expect(sessionCost(session({ calls: [call({ usage })] }))).toBeGreaterThan(0.05); // so mk(base) itself is compared
  });

  it('reports the median deviation next to the worst', () => {
    // deviations 0, 0.05, 0.5, 0.5 -> median (0.05 + 0.5) / 2; and an odd count -> the middle one
    const four = reconcile([mk(base), mk(base * 1.05), mk(base * 2), mk(base * 2)]);
    expect(four.medianDeviation).toBeCloseTo((0.05 / 1.05 + 0.5) / 2, 6);
    expect(four.worstDeviation).toBeCloseTo(0.5, 6);
    const three = reconcile([mk(base), mk(base * 2), mk(base * 100)]);
    expect(three.medianDeviation).toBeCloseTo(0.5, 6);
    expect(three.worstDeviation).toBeCloseTo(0.99, 6);
    expect(reconcile([]).medianDeviation).toBe(0);
  });

  it('skips sessions without calls', () => {
    expect(reconcile([session({ reportedCostUSD: 5 })]).sessionsChecked).toBe(0);
  });

  it('honours a custom tolerance and the boundary', () => {
    expect(reconcile([mk(base / 0.91)], 0.1).withinTolerance).toBe(1); // deviation 9%
    expect(reconcile([mk(base / 0.89)], 0.1).withinTolerance).toBe(0); // deviation 11%
    expect(reconcile([mk(base / 0.89)], 0.25).withinTolerance).toBe(1);
  });

  it('is reported by analyzeSpend', () => {
    expect(analyzeSpend(corpus([mk(base), mk(base * 3)])).reconciliation.sessionsChecked).toBe(2);
  });
});
