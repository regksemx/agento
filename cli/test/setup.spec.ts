import { describe, expect, it } from 'vitest';
import { priceOf } from '../../plugin/core/pricing.ts';
import { analyzeSetup } from '../src/audit/setup.ts';
import { MIN, T0, call, corpus, session, step } from './corpus-builder.ts';

const first = (sid: string, creation: number, read = 0, p = {}) =>
  call({ sessionId: sid, ts: T0, usage: { cache_creation_input_tokens: creation, cache_read_input_tokens: read }, ...p });

describe('analyzeSetup fixed prefix', () => {
  it('is zero for an empty corpus', () => {
    expect(analyzeSetup(corpus([]), { readFile: () => null })).toEqual({ avgFixedPrefixTokens: 0, fixedPrefixCost: 0, claudeMd: [] });
  });

  it('averages the first main call of each session and prices its cache writes', () => {
    const c = corpus([
      session({ sessionId: 'a', calls: [first('a', 20_000), step(T0 + MIN, 20_000, 500, 100, { sessionId: 'a' })] }),
      session({ sessionId: 'b', calls: [first('b', 10_000, 20_000, { model: 'claude-sonnet-5-5' })] }),
      session({ sessionId: 'c', calls: [call({ sessionId: 'c', lineage: 'agent:x', usage: { cache_creation_input_tokens: 999_999 } })] }),
    ]);
    const r = analyzeSetup(c, { readFile: () => null });
    // (20k + 30k) / 2 sessions that have a main call
    expect(r.avgFixedPrefixTokens).toBe(25_000);
    // 20k * $5 + 10k * $2.5, per million
    expect(r.fixedPrefixCost).toBeCloseTo(0.1 + 0.025, 10);
  });

  it('counts input tokens in the prefix', () => {
    const c = corpus([session({ calls: [call({ ts: T0, usage: { input_tokens: 1_000, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 3_000 } })] })]);
    expect(analyzeSetup(c, { readFile: () => null }).avgFixedPrefixTokens).toBe(6_000);
  });
});

describe('analyzeSetup claudeMd', () => {
  const files: Record<string, string> = {
    '/p/a/CLAUDE.md': 'x'.repeat(500),
    '/p/b/.claude/CLAUDE.md': 'y'.repeat(2_000),
    '/p/b/CLAUDE.md': 'z'.repeat(100),
    '/p/u/CLAUDE.md': 'é'.repeat(10), // 20 bytes
  };
  const read = (p: string) => files[p] ?? null;

  it('reads both locations per distinct cwd, dedupes, sorts by size', () => {
    const c = corpus([
      session({ sessionId: '1', cwd: '/p/a', calls: [first('1', 1)] }),
      session({ sessionId: '2', cwd: '/p/a', calls: [first('2', 1)] }),
      session({ sessionId: '3', cwd: '/p/b', calls: [first('3', 1)] }),
      session({ sessionId: '4', cwd: '/p/u', calls: [first('4', 1)] }),
      session({ sessionId: '5', cwd: '/p/none', calls: [first('5', 1)] }),
      session({ sessionId: '6', calls: [first('6', 1)] }),
    ]);
    expect(analyzeSetup(c, { readFile: read }).claudeMd.map((f) => [f.path, f.bytes])).toEqual([
      ['/p/b/.claude/CLAUDE.md', 2_000],
      ['/p/a/CLAUDE.md', 500],
      ['/p/b/CLAUDE.md', 100],
      ['/p/u/CLAUDE.md', 20],
    ]);
  });

  it('keeps the top 10 only', () => {
    const sessions = Array.from({ length: 15 }, (_, i) => session({ sessionId: `s${i}`, cwd: `/d${i}`, calls: [first(`s${i}`, 1)] }));
    const r = analyzeSetup(corpus(sessions), { readFile: (p) => (p.endsWith('/CLAUDE.md') && !p.includes('.claude') ? 'a'.repeat(Number(/d(\d+)/.exec(p)![1]) + 1) : null) });
    expect(r.claudeMd).toHaveLength(10);
    expect(r.claudeMd[0]).toMatchObject({ path: '/d14/CLAUDE.md', bytes: 15 });
  });

  it('survives a throwing reader and defaults to the disk', () => {
    const c = corpus([session({ cwd: '/definitely/not/here', calls: [first('s1', 1)] })]);
    expect(analyzeSetup(c, { readFile: () => { throw new Error('boom'); } }).claudeMd).toEqual([]);
    expect(analyzeSetup(c).claudeMd).toEqual([]);
  });
});

describe('analyzeSetup CLAUDE.md cost', () => {
  const KB20 = 20 * 1024;
  const big = 'x'.repeat(KB20 + 3_600); // 20 KB + 1000 tokens
  const small = 'y'.repeat(3_600); // 1000 tokens
  const files: Record<string, string> = { '/p/a/CLAUDE.md': big, '/p/b/CLAUDE.md': small };
  const read = (p: string) => files[p] ?? null;
  const reads = (sid: string, cwd: string, model: string, n: number) =>
    session({ sessionId: sid, cwd, calls: Array.from({ length: n }, (_, i) => step(T0 + i * MIN, 10_000, 100, 10, { sessionId: sid, model })) });

  it('estimates tokens as bytes / 3.6', () => {
    const [f] = analyzeSetup(corpus([reads('1', '/p/b', 'claude-opus-5-5', 1)]), { readFile: read, days: 30 }).claudeMd;
    expect(f!.tokens).toBeCloseTo(1_000, 6);
  });

  it('prices every main call of sessions started in the file directory at the cache-read price of its model', () => {
    const c = corpus([
      reads('1', '/p/b', 'claude-opus-5-5', 100),
      reads('2', '/p/b', 'claude-opus-5', 100),
      reads('3', '/p/a', 'claude-opus-5-5', 999), // another directory
      session({ sessionId: '4', cwd: '/p/b', calls: [call({ sessionId: '4', lineage: 'agent:x', usage: { cache_read_input_tokens: 1 } })] }), // subagents do not count
    ]);
    const f = analyzeSetup(c, { readFile: read, days: 30 }).claudeMd.find((x) => x.path === '/p/b/CLAUDE.md')!;
    const perCall = (model: string) => (1_000 * priceOf(model)!.cacheRead) / 1_000_000;
    expect(priceOf('claude-opus-5-5')!.cacheRead).not.toBe(priceOf('claude-opus-5')!.cacheRead);
    expect(f.monthlyReadCost).toBeCloseTo(100 * perCall('claude-opus-5-5') + 100 * perCall('claude-opus-5'), 10);
    expect(f.trimSaving).toBe(0); // under 20 KB
  });

  it('scales to 30 days by the covered period', () => {
    const c = corpus([reads('1', '/p/b', 'claude-opus-5-5', 10)]);
    const at = (days: number) => analyzeSetup(c, { readFile: read, days }).claudeMd[0]!.monthlyReadCost;
    expect(at(60)).toBeCloseTo(at(30) / 2, 12);
    expect(at(15)).toBeCloseTo(at(30) * 2, 12);
    expect(at(0)).toBeCloseTo(at(1), 12); // never divides by zero
    // without `days` the span of the requests is used: 9 minutes -> one day
    expect(analyzeSetup(c, { readFile: read }).claudeMd[0]!.monthlyReadCost).toBeCloseTo(at(1), 12);
  });

  it('values the trim as the reads of everything above 20 KB', () => {
    const c = corpus([reads('1', '/p/a', 'claude-opus-5-5', 50)]);
    const f = analyzeSetup(c, { readFile: read, days: 30 }).claudeMd[0]!;
    expect(f.bytes).toBe(KB20 + 3_600);
    expect(f.trimSaving).toBeCloseTo(f.monthlyReadCost * (1_000 / f.tokens), 10);
    expect(f.trimSaving).toBeGreaterThan(0);
    expect(f.trimSaving).toBeLessThan(f.monthlyReadCost);
  });

  it('is free for directories without main calls or unknown models', () => {
    const c = corpus([reads('1', '/p/b', 'claude-mystery-9', 5), session({ sessionId: '2', cwd: '/p/a' })]);
    const r = analyzeSetup(c, { readFile: read, days: 30 }).claudeMd;
    expect(r.map((f) => f.monthlyReadCost)).toEqual([0, 0]);
  });
});
