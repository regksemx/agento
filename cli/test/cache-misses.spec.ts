import { describe, expect, it } from 'vitest';
import { analyzeCacheMisses } from '../src/audit/cache-misses.ts';
import type { CacheSection, MissCause } from '../src/types.ts';
import { MIN, T0, call, corpus, marker, session, step } from './corpus-builder.ts';

const warm = (ts: number, p = {}) => step(ts, 50_000, 1_000, 500, p);
// 60k tokens written from scratch: a full rewrite on an opus-5.5 prefix of 60k.
const rewrite = (ts: number, p = {}) => call({ ts, usage: { cache_creation_input_tokens: 60_000, output_tokens: 500 }, ...p });
const loss = (s: CacheSection, cause: MissCause) => s.losses.find((l) => l.cause === cause)!;

describe('analyzeCacheMisses', () => {
  it('computes the hit ratio over the main lineage only', () => {
    const c = corpus([
      session({
        calls: [
          step(T0, 90_000, 10_000),
          call({ ts: T0 + MIN, lineage: 'agent:a1', usage: { cache_creation_input_tokens: 500_000 } }),
        ],
      }),
    ]);
    expect(analyzeCacheMisses(c).hitRatio).toBeCloseTo(0.9, 10);
  });

  it('returns zeros for an empty corpus', () => {
    const r = analyzeCacheMisses(corpus([]));
    expect(r.hitRatio).toBe(0);
    expect(r.rewriteCost).toBe(0);
    expect(r.losses.every((l) => l.events === 0)).toBe(true);
  });

  it('recognizes ttl: pause longer than 5m', () => {
    const r = analyzeCacheMisses(corpus([session({ calls: [warm(T0), warm(T0 + MIN), rewrite(T0 + 10 * MIN)] })]));
    expect(loss(r, 'ttl').events).toBe(1);
    // 60k * ($5 - $0.20) / 1M
    expect(loss(r, 'ttl').cost).toBeCloseTo(0.288, 6);
    expect(r.rewriteCost).toBeCloseTo(0.288, 6);
  });

  it('does not blame ttl for a 10m pause when the session uses the 1h cache', () => {
    const oneHour = { cache_creation: { ephemeral_1h_input_tokens: 1_000 } };
    const calls = [
      call({ ts: T0, usage: { cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000, ...oneHour } }),
      warm(T0 + MIN), // read-only follow-up: the 1h TTL still applies
      rewrite(T0 + 11 * MIN),
    ];
    const r = analyzeCacheMisses(corpus([session({ calls })]));
    expect(loss(r, 'ttl').events).toBe(0);
    expect(loss(r, 'unknown').events).toBe(1);
  });

  it('blames ttl after more than an hour on the 1h cache', () => {
    const oneHour = { cache_creation: { ephemeral_1h_input_tokens: 1_000 } };
    const calls = [call({ ts: T0, usage: { cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000, ...oneHour } }), rewrite(T0 + 70 * MIN)];
    expect(loss(analyzeCacheMisses(corpus([session({ calls })])), 'ttl').events).toBe(1);
  });

  it('recognizes model-switch', () => {
    const calls = [warm(T0), rewrite(T0 + MIN, { model: 'claude-sonnet-5-5' })];
    const r = analyzeCacheMisses(corpus([session({ calls })]));
    expect(loss(r, 'model-switch').events).toBe(1);
    // priced with the new model: 60k * ($2.5 - $0.2) / 1M
    expect(loss(r, 'model-switch').cost).toBeCloseTo(0.138, 6);
  });

  it('recognizes compaction and clear markers between the calls', () => {
    for (const kind of ['compact', 'clear'] as const) {
      const calls = [warm(T0), rewrite(T0 + 2 * MIN)];
      const r = analyzeCacheMisses(corpus([session({ calls, markers: [marker(kind, T0 + MIN)] })]));
      expect(loss(r, 'compaction').events).toBe(1);
    }
  });

  it('ignores markers outside the gap between the two calls', () => {
    const calls = [warm(T0), rewrite(T0 + 2 * MIN)];
    const r = analyzeCacheMisses(corpus([session({ calls, markers: [marker('compact', T0 - MIN), marker('model', T0 + MIN)] })]));
    expect(loss(r, 'compaction').events).toBe(0);
    expect(loss(r, 'unknown').events).toBe(1);
  });

  it('prefers compaction over model-switch and ttl', () => {
    const calls = [warm(T0), rewrite(T0 + 30 * MIN, { model: 'claude-sonnet-5-5' })];
    const r = analyzeCacheMisses(corpus([session({ calls, markers: [marker('compact', T0 + 29 * MIN)] })]));
    expect(loss(r, 'compaction').events).toBe(1);
    expect(loss(r, 'model-switch').events).toBe(0);
    expect(loss(r, 'ttl').events).toBe(0);
  });

  it('prefers model-switch over ttl', () => {
    const calls = [warm(T0), rewrite(T0 + 30 * MIN, { model: 'claude-sonnet-5-5' })];
    const r = analyzeCacheMisses(corpus([session({ calls })]));
    expect(loss(r, 'model-switch').events).toBe(1);
    expect(loss(r, 'ttl').events).toBe(0);
  });

  it('recognizes effort-change on a family where it busts the cache', () => {
    const calls = [warm(T0, { model: 'claude-opus-4-6', effort: 'high' }), rewrite(T0 + MIN, { model: 'claude-opus-4-6', effort: 'low' })];
    expect(loss(analyzeCacheMisses(corpus([session({ calls })])), 'effort-change').events).toBe(1);
  });

  it('does not blame effort-change on cache-safe families', () => {
    const calls = [warm(T0, { effort: 'high' }), rewrite(T0 + MIN, { effort: 'low' })];
    const r = analyzeCacheMisses(corpus([session({ calls })]));
    expect(loss(r, 'effort-change').events).toBe(0);
    expect(loss(r, 'unknown').events).toBe(1);
  });

  it('falls back to unknown', () => {
    const r = analyzeCacheMisses(corpus([session({ calls: [warm(T0), rewrite(T0 + MIN)] })]));
    expect(loss(r, 'unknown').events).toBe(1);
  });

  it('skips the first call of a session, small prefixes and small writes', () => {
    const calls = [
      rewrite(T0), // first call: not an event
      call({ ts: T0 + MIN, usage: { cache_creation_input_tokens: 7_000 } }), // prefix below 8k
      step(T0 + 2 * MIN, 50_000, 10_000), // 10k of 60k: below 20%
      step(T0 + 3 * MIN, 40_000, 10_000), // exactly 20%: not above
    ];
    const r = analyzeCacheMisses(corpus([session({ calls })]));
    expect(r.losses.reduce((a, l) => a + l.events, 0)).toBe(0);
    expect(r.rewriteCost).toBe(0);
  });

  it('keeps sessions apart and ignores subagent rewrites', () => {
    const a = session({ sessionId: 'a', calls: [warm(T0, { sessionId: 'a' })] });
    const b = session({ sessionId: 'b', calls: [rewrite(T0 + MIN, { sessionId: 'b' })] }); // first call of its session
    const c = session({ sessionId: 'c', calls: [warm(T0, { sessionId: 'c' }), rewrite(T0 + 2 * MIN, { sessionId: 'c', lineage: 'agent:x' })] });
    const r = analyzeCacheMisses(corpus([a, b, c]));
    expect(r.losses.reduce((x, l) => x + l.events, 0)).toBe(0);
  });

  it('prices 1h writes at the 1h rate and never goes negative', () => {
    const calls = [
      warm(T0),
      rewrite(T0 + 70 * MIN, { usage: { cache_creation_input_tokens: 60_000, cache_creation: { ephemeral_1h_input_tokens: 60_000 } } }),
    ];
    // 60k * ($8 - $0.2) / 1M
    expect(analyzeCacheMisses(corpus([session({ calls })])).rewriteCost).toBeCloseTo(0.468, 6);
    const unknown = analyzeCacheMisses(corpus([session({ calls: [warm(T0), rewrite(T0 + MIN, { model: 'mystery' })] })]));
    expect(unknown.rewriteCost).toBe(0);
  });

  it('sums costs per cause', () => {
    const calls = [warm(T0), rewrite(T0 + 10 * MIN), warm(T0 + 11 * MIN), rewrite(T0 + 30 * MIN)];
    const r = analyzeCacheMisses(corpus([session({ calls })]));
    expect(loss(r, 'ttl').events).toBe(2);
    expect(r.rewriteCost).toBeCloseTo(0.576, 6);
  });
});
