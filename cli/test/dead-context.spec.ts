import { describe, expect, it } from 'vitest';
import { analyzeDeadContext } from '../src/audit/dead-context.ts';
import { call, corpus, marker, MIN, prompt, session, step, T0 } from './corpus-builder.ts';

const OLD = 'fix the failing auth middleware test in src/auth/middleware.ts';
const NEW = 'добавь страницу с ценами и форму обратной связи на лендинг';

// Prefix of step(ts, 80_000) = 80k read + 2k written = 82k tokens.
const build = (opts: { gapMin?: number; prefix?: number; newText?: string; extra?: Parameters<typeof session>[0] } = {}) => {
  const gap = opts.gapMin ?? 20;
  const tNew = T0 + MIN + gap * MIN;
  return session({
    prompts: [prompt(OLD, T0), prompt(opts.newText ?? NEW, tNew)],
    calls: [
      step(T0 + MIN, opts.prefix ?? 80_000),
      step(tNew + 1000, 85_000),
      step(tNew + 2000, 86_000),
      step(tNew + 3000, 87_000),
    ],
    ...opts.extra,
  });
};

describe('analyzeDeadContext', () => {
  it('prices the old prefix re-read on every later step of the task', () => {
    const r = analyzeDeadContext(corpus([build()]));
    expect(r.events).toBe(1);
    // old prefix 82k tokens x opus-5.5 cache read $0.20/MTok x 3 steps
    expect(r.cost).toBeCloseTo((82_000 * 0.2 * 3) / 1e6, 12);
  });

  it('uses the cache read price of each later call model', () => {
    const s = build();
    s.calls[2] = call({ ...s.calls[2]!, model: 'claude-haiku-4-5' });
    const r = analyzeDeadContext(corpus([s]));
    expect(r.cost).toBeCloseTo((82_000 * 0.2 + 82_000 * 0.1 + 82_000 * 0.2) / 1e6, 12);
  });

  it('needs a shift >= 0.85, idle >= 10 min and a prefix >= 60k', () => {
    expect(analyzeDeadContext(corpus([build({ newText: 'also fix the auth middleware test failures' })])).events).toBe(0);
    expect(analyzeDeadContext(corpus([build({ gapMin: 5 })])).events).toBe(0);
    expect(analyzeDeadContext(corpus([build({ gapMin: 9 })])).events).toBe(0);
    expect(analyzeDeadContext(corpus([build({ prefix: 50_000 })])).events).toBe(0);
    expect(analyzeDeadContext(corpus([build({ prefix: 57_000 })])).events).toBe(0); // 59k
    expect(analyzeDeadContext(corpus([build({ prefix: 58_000 })])).events).toBe(1); // 60k
  });

  it('skips shifts after /clear or compaction and ignores slash commands', () => {
    const cleared = build({ extra: { markers: [marker('clear', T0 + 10 * MIN)] } });
    expect(analyzeDeadContext(corpus([cleared])).events).toBe(0);

    const s = build();
    s.prompts.splice(1, 0, prompt('/model sonnet', T0 + 5 * MIN));
    expect(analyzeDeadContext(corpus([s])).events).toBe(1);
  });

  it('stops counting at the next task boundary or compaction', () => {
    const tNew = T0 + 21 * MIN;
    const s = build({ extra: { markers: [marker('compact', tNew + 2500)] } });
    expect(analyzeDeadContext(corpus([s])).cost).toBeCloseTo((82_000 * 0.2 * 2) / 1e6, 12);

    // a prompt after a 90 min break starts a new task: its calls are not charged to the first event,
    // but it is a shift of its own (prefix 89k at that point, one later call)
    const later = build();
    later.prompts.push(prompt('rename tmp to buffer in the exporter module', tNew + 90 * MIN));
    later.calls.push(step(tNew + 91 * MIN, 90_000));
    const r = analyzeDeadContext(corpus([later]));
    expect(r.events).toBe(2);
    expect(r.cost).toBeCloseTo((82_000 * 0.2 * 3 + 89_000 * 0.2) / 1e6, 12);
  });

  it('ignores subagent calls and sums across sessions', () => {
    const a = build();
    a.calls.push(call({ ts: T0 + 22 * MIN, lineage: 'agent:q', usage: { cache_read_input_tokens: 500_000 } }));
    const b = build({ extra: { sessionId: 's2' } });
    const r = analyzeDeadContext(corpus([a, b]));
    expect(r.events).toBe(2);
    expect(r.cost).toBeCloseTo((82_000 * 0.2 * 3 * 2) / 1e6, 12);
  });
});
