import { describe, expect, it } from 'vitest';
import { analyzeTtl } from '../src/audit/ttl.ts';
import type { ApiCall } from '../src/types.ts';
import { MIN, T0, call, corpus, session } from './corpus-builder.ts';

// A write of `n` tokens into the 5m or 1h cache, reading `read` tokens.
const w = (ts: number, n: number, ttl: '5m' | '1h', read = 0, p: Partial<ApiCall> = {}) =>
  call({
    ...p,
    ts,
    usage: {
      cache_read_input_tokens: read,
      cache_creation_input_tokens: n,
      cache_creation: ttl === '5m' ? { ephemeral_5m_input_tokens: n, ephemeral_1h_input_tokens: 0 } : { ephemeral_1h_input_tokens: n, ephemeral_5m_input_tokens: 0 },
    },
  });

const counts = (r: ReturnType<typeof analyzeTtl>) => r.gapHistogram.map((b) => b.count);

describe('analyzeTtl observed', () => {
  it('is unknown without breakdowns', () => {
    const c = corpus([session({ calls: [call({ ts: T0, usage: { cache_creation_input_tokens: 1000 } })] })]);
    expect(analyzeTtl(c).observed).toBe('unknown');
    expect(analyzeTtl(corpus([])).observed).toBe('unknown');
  });

  it('detects 5m, 1h and mixed by the 90% rule', () => {
    const at = (n5: number, n1: number) =>
      analyzeTtl(corpus([session({ calls: [w(T0, n5, '5m'), w(T0 + MIN, n1, '1h')] })])).observed;
    expect(at(1000, 0)).toBe('5m');
    expect(at(900, 100)).toBe('5m');
    expect(at(0, 1000)).toBe('1h');
    expect(at(100, 900)).toBe('1h');
    expect(at(500, 500)).toBe('mixed');
    expect(at(899, 101)).toBe('mixed');
  });

  it('ignores subagent calls', () => {
    const c = corpus([session({ calls: [w(T0, 1000, '5m'), w(T0 + MIN, 99_000, '1h', 0, { lineage: 'agent:a' })] })]);
    expect(analyzeTtl(c).observed).toBe('5m');
  });
});

describe('analyzeTtl gap histogram', () => {
  it('buckets idle gaps between consecutive main calls per session', () => {
    const times = [0, 30_000, 30_000 + 2 * MIN, 30_000 + 2 * MIN + 10 * MIN, 30_000 + 12 * MIN + 30 * MIN, 30_000 + 42 * MIN + 90 * MIN];
    const calls = times.map((t) => w(T0 + t, 100, '5m'));
    // a second session must not create a gap to the first one
    const other = session({ sessionId: 'z', calls: [w(T0 + 500 * MIN, 100, '5m', 0, { sessionId: 'z' })] });
    const r = analyzeTtl(corpus([session({ calls }), other]));
    expect(r.gapHistogram.map((b) => b.label)).toEqual(['<1m', '1–5m', '5–15m', '15–60m', '>60m']);
    expect(counts(r)).toEqual([1, 1, 1, 1, 1]);
  });

  it('puts exact boundaries in the upper bucket', () => {
    const calls = [0, 1, 6, 21, 81].reduce<ApiCall[]>((acc, m, i, a) => acc.concat(w(T0 + m * MIN, 10, '5m')), []);
    expect(counts(analyzeTtl(corpus([session({ calls })])))).toEqual([0, 1, 1, 1, 1]);
  });
});

describe('analyzeTtl recommendation', () => {
  // Pauses of 10m, every return rewrites the 100k prefix on the 5m cache.
  const gappy = () => {
    const calls = [w(T0, 100_000, '5m')];
    for (let i = 1; i <= 4; i++) calls.push(w(T0 + i * 10 * MIN, 100_000, '5m'));
    return corpus([session({ calls })]);
  };
  // Calls every minute: 5m cache is never cold.
  const busy = () => {
    const calls = [w(T0, 100_000, '5m')];
    for (let i = 1; i <= 20; i++) calls.push(w(T0 + i * MIN, 1_000, '5m', 100_000));
    return corpus([session({ calls })]);
  };

  it('recommends 1h for a corpus with pauses of 5-60 minutes', () => {
    const r = analyzeTtl(gappy());
    expect(r.observed).toBe('5m');
    expect(r.recommendation?.ttl).toBe('1h');
    // saving: 4 * 100k * (5 - 0.2) / 1M = 1.92; premium: first write 100k * 3 / 1M = 0.30; span < 1 day -> x30
    expect(r.recommendation?.monthlySaving.kind).toBe('estimate');
    expect(r.recommendation?.monthlySaving.usd).toBeCloseTo(1.62 * 30, 6);
    expect(r.recommendation?.reason).toMatch(/1h/);
  });

  it('scales by the days covered', () => {
    const c = gappy();
    const r = analyzeTtl(c, T0 + 40 * MIN + 10 * 24 * 60 * MIN);
    expect(r.recommendation?.monthlySaving.usd).toBeCloseTo((1.62 * 30) / (10 + 40 / 1440), 4);
  });

  it('does not recommend 1h when calls are frequent', () => {
    expect(analyzeTtl(busy()).recommendation).toBeNull();
  });

  it('does not recommend 1h when pauses exceed an hour', () => {
    const calls = [w(T0, 100_000, '5m'), w(T0 + 90 * MIN, 100_000, '5m'), w(T0 + 180 * MIN, 100_000, '5m')];
    expect(analyzeTtl(corpus([session({ calls })])).recommendation).toBeNull();
  });

  it('does not recommend anything when observed ttl is mixed or unknown', () => {
    const mixed = corpus([session({ calls: [w(T0, 100_000, '5m'), w(T0 + 10 * MIN, 100_000, '1h')] })]);
    expect(analyzeTtl(mixed).recommendation).toBeNull();
    expect(analyzeTtl(corpus([])).recommendation).toBeNull();
  });

  it('on 1h recommends 5m only when clearly cheaper', () => {
    // frequent calls, big 1h writes, few reads: paying 2x for nothing
    const calls = [w(T0, 100_000, '1h'), w(T0 + MIN, 100_000, '1h'), w(T0 + 2 * MIN, 100_000, '1h')];
    const r = analyzeTtl(corpus([session({ calls })]));
    expect(r.observed).toBe('1h');
    expect(r.recommendation?.ttl).toBe('5m');
    // 3 * 100k * (8 - 5) / 1M = 0.9, x30
    expect(r.recommendation?.monthlySaving.usd).toBeCloseTo(27, 6);
  });

  it('on 1h keeps it when pauses of 5-60 minutes make 5m costlier', () => {
    const calls = [w(T0, 100_000, '1h')];
    for (let i = 1; i <= 4; i++) calls.push(w(T0 + i * 10 * MIN, 0, '1h', 100_000));
    expect(analyzeTtl(corpus([session({ calls })])).recommendation).toBeNull();
  });

  it('on 1h keeps it when the saving is below 10% of the cache spend', () => {
    // one 1h write, then lots of cheap reads in quick succession
    const calls = [w(T0, 100_000, '1h')];
    for (let i = 1; i <= 30; i++) calls.push(w(T0 + i * MIN, 0, '1h', 100_000));
    // saving 0.3 of (0.8 + 30 * 0.02 = 1.4) = 21% -> would recommend; with 200 reads (4.8) it is only 6%
    const heavy = [w(T0, 100_000, '1h')];
    for (let i = 1; i <= 200; i++) heavy.push(w(T0 + i * MIN, 0, '1h', 100_000));
    expect(analyzeTtl(corpus([session({ calls })])).recommendation?.ttl).toBe('5m');
    expect(analyzeTtl(corpus([session({ calls: heavy })])).recommendation).toBeNull();
  });
});
