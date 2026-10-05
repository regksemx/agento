import { describe, expect, it } from 'vitest';
import type { LineageState } from './cache.ts';
import { TRAJECTORY_LIMITS, checkpointReached, decideTrajectory, emptyTrajectory, foldStep, foldToolCall, normalizeTrajectory, type TrajectoryFacts, type TrajectoryStats } from './trajectory.ts';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const NOW = 1_760_000_000_000;

const call = (s: TrajectoryStats, tool: string, input: Record<string, unknown> = {}, isError = false, text?: string): TrajectoryStats => foldToolCall(s, { tool, input, isError, text });
const step = (s: TrajectoryStats, out = 500): TrajectoryStats => foldStep(s, { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 1000 });

const cache = (prefixTokens: number, model = OPUS): LineageState => ({ model, prefixTokens, lastAt: NOW - 1000, ttl: '5m' });

const facts = (o: Partial<TrajectoryFacts>): TrajectoryFacts => ({
  stats: emptyTrajectory(),
  promptVerdict: null,
  current: { model: OPUS, effort: 'high' },
  cache: cache(9000),
  now: NOW,
  mode: 'balanced',
  alreadyDecided: false,
  ...o,
});

// A small task: read one file, change it, nothing goes wrong.
function small(): TrajectoryStats {
  let s = emptyTrajectory();
  s = step(s);
  s = call(s, 'Read', { file_path: '/a.ts' });
  s = step(s);
  s = call(s, 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' });
  return s;
}

// Four steps that only read.
function explored(distinct = 4): TrajectoryStats {
  let s = emptyTrajectory();
  for (let i = 0; i < 4; i++) s = step(call(s, 'Read', { file_path: `/f${i % distinct}` }));
  return s;
}

describe('foldToolCall', () => {
  it('counts reads with distinct files, and searches', () => {
    let s = emptyTrajectory();
    s = call(s, 'Read', { file_path: '/a.ts' });
    s = call(s, 'Read', { file_path: '/a.ts' });
    s = call(s, 'Read', { file_path: '/b.ts' });
    s = call(s, 'Grep', { pattern: 'x' });
    s = call(s, 'Glob', { pattern: '*.ts' });
    expect(s).toMatchObject({ reads: 3, searches: 2, filesRead: ['/a.ts', '/b.ts'], edits: 0, hasEdit: false });
  });

  it('counts edits, their distinct files and what they wrote', () => {
    let s = emptyTrajectory();
    s = call(s, 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'abc' });
    s = call(s, 'MultiEdit', { file_path: '/a.ts', edits: [{ old_string: 'p', new_string: '12' }, { old_string: 'q', new_string: '3' }] });
    s = call(s, 'Write', { file_path: '/b.ts', content: '0123456789' });
    expect(s).toMatchObject({ edits: 3, filesEdited: ['/a.ts', '/b.ts'], editChars: 3 + 3 + 10, hasEdit: true });
  });

  it('counts tool errors and the streak that ends now', () => {
    let s = emptyTrajectory();
    s = call(s, 'Read', { file_path: '/a' }, true);
    s = call(s, 'Read', { file_path: '/b' }, true);
    expect(s).toMatchObject({ toolErrors: 2, errorStreak: 2 });
    s = call(s, 'Read', { file_path: '/c' });
    expect(s).toMatchObject({ toolErrors: 2, errorStreak: 0 });
  });

  it("counts a failing test run, by the error flag or the runner's own summary, and not other failing commands", () => {
    let s = emptyTrajectory();
    s = call(s, 'Bash', { command: 'npx vitest run' }, true);
    s = call(s, 'Bash', { command: 'npm test' }, false, 'Tests: 2 failed, 5 passed');
    s = call(s, 'Bash', { command: 'npm test' }, false, 'Tests: 7 passed');
    s = call(s, 'Bash', { command: 'ls /nope' }, true);
    expect(s.failingTests).toBe(2);
    expect(s.toolErrors).toBe(2);
  });

  it('does not mutate what it was given and caps the file lists', () => {
    const a = emptyTrajectory();
    const b = call(a, 'Read', { file_path: '/a.ts' });
    expect(a.filesRead).toEqual([]);
    expect(b).not.toBe(a);
    let s = emptyTrajectory();
    for (let i = 0; i < 100; i++) s = call(s, 'Read', { file_path: `/f${i}.ts` });
    expect(s.filesRead).toHaveLength(TRAJECTORY_LIMITS.maxFiles);
    expect(s.reads).toBe(100);
  });
});

describe('foldStep', () => {
  it('counts steps and sums new input (not cache reads) and output', () => {
    const s = foldStep(foldStep(emptyTrajectory(), { input_tokens: 5, output_tokens: 100, cache_creation_input_tokens: 995 }), { output_tokens: 50 });
    expect(s).toMatchObject({ steps: 2, inputTokens: 1000, outputTokens: 150 });
  });
});

describe('normalizeTrajectory: state an older version persisted', () => {
  it.each([undefined, null, 'x', 3, {}])('%j reads as nothing seen yet', (v) => {
    expect(normalizeTrajectory(v)).toEqual(emptyTrajectory());
  });

  it('keeps what is valid and drops what is not', () => {
    const s = normalizeTrajectory({ steps: 3, edits: 2, filesRead: ['/a', 5], toolErrors: -4, outputTokens: 'x' });
    expect(s).toMatchObject({ steps: 3, edits: 2, hasEdit: true, filesRead: ['/a'], toolErrors: 0, outputTokens: 0 });
  });

  it('is what the folds and the decision work from, whatever they are handed', () => {
    expect(foldStep({} as TrajectoryStats, { output_tokens: 1 }).steps).toBe(1);
    expect(decideTrajectory(facts({ stats: {} as TrajectoryStats }))).toBeNull();
  });
});

describe('checkpoint', () => {
  it('is four main steps, or the first edit if that comes sooner', () => {
    const s = explored();
    const before = { ...s, steps: TRAJECTORY_LIMITS.checkpointSteps - 1 };
    expect(checkpointReached(before)).toBe(false);
    expect(decideTrajectory(facts({ stats: before }))).toBeNull();
    expect(checkpointReached(s)).toBe(true);
    expect(checkpointReached(small())).toBe(true);
    // An edit before any step has finished is not a checkpoint yet: there is nothing to say of the task.
    expect(checkpointReached(call(emptyTrajectory(), 'Edit', { file_path: '/a', new_string: 'x' }))).toBe(false);
  });
});

describe('decideTrajectory: complexity', () => {
  it('small: few files, a mechanical edit, no errors', () => {
    const v = decideTrajectory(facts({ stats: small() }));
    expect(v?.complexity).toBe('small');
    expect(v?.spawnTier).toBe('sonnet');
    expect(v?.reasons).toEqual(['files: 1', 'edits: 1', 'no errors']);
  });

  it('medium: nothing contradicts it, nothing says it is small (no edit yet after four steps)', () => {
    const v = decideTrajectory(facts({ stats: explored() }));
    expect(v?.complexity).toBe('medium');
    expect(v?.spawnTier).toBeNull();
    expect(v?.mainDowngrade).toBeNull();
  });

  it('medium: a big edit is not mechanical', () => {
    const s = call(step(emptyTrajectory()), 'Write', { file_path: '/a.ts', content: 'x'.repeat(TRAJECTORY_LIMITS.smallEditChars + 1) });
    expect(decideTrajectory(facts({ stats: s }))?.complexity).toBe('medium');
  });

  it('medium: a tool error keeps it from being small', () => {
    expect(decideTrajectory(facts({ stats: call(small(), 'Bash', { command: 'ls' }, true) }))?.complexity).toBe('medium');
  });

  // Four steps in, so the checkpoint is reached.
  const base = (): TrajectoryStats => explored(1);
  const many = (): TrajectoryStats => {
    let s = base();
    for (let i = 0; i < TRAJECTORY_LIMITS.largeFiles; i++) s = call(s, 'Read', { file_path: `/f${i}` });
    return s;
  };
  const streak = (): TrajectoryStats => call(call(base(), 'Read', { file_path: '/a' }, true), 'Read', { file_path: '/b' }, true);
  const errors = (): TrajectoryStats => {
    let s = base();
    for (let i = 0; i < 3; i++) s = call(call(s, 'Read', { file_path: '/a' }, true), 'Read', { file_path: '/b' });
    return s;
  };
  const failing = (): TrajectoryStats => {
    let s = base();
    for (let i = 0; i < 2; i++) s = call(call(s, 'Bash', { command: 'npm test' }, true), 'Read', { file_path: `/f${i}` });
    return s;
  };
  const burn = (): TrajectoryStats => foldStep(base(), { output_tokens: TRAJECTORY_LIMITS.largeOutputTokens });

  it.each([
    ['many files', many],
    ['an error streak', streak],
    ['three tool errors', errors],
    ['failing test runs', failing],
    ['a high token burn', burn],
  ])('large: %s', (_name, make) => {
    const v = decideTrajectory(facts({ stats: make() }));
    expect(v?.complexity).toBe('large');
    // Large never argues anything down, and subagents are left to the spawn policy.
    expect(v).toMatchObject({ spawnTier: null, handoff: false, mainDowngrade: null });
    expect(v?.reasons.length).toBeGreaterThan(0);
  });
});

describe('decideTrajectory: once, and only when agento acts', () => {
  it('null once decided', () => {
    expect(decideTrajectory(facts({ stats: small(), alreadyDecided: true }))).toBeNull();
  });

  it.each(['quality', 'off'] as const)('null in %s mode', (mode) => {
    expect(decideTrajectory(facts({ stats: small(), mode }))).toBeNull();
  });

  it('eco decides as balanced does', () => {
    expect(decideTrajectory(facts({ stats: small(), mode: 'eco' }))?.complexity).toBe('small');
  });
});

describe('decideTrajectory: only downward', () => {
  it('a user on sonnet or haiku gets nothing to go down to', () => {
    for (const model of [SONNET, 'claude-haiku-4-5']) {
      const v = decideTrajectory(facts({ stats: small(), current: { model, effort: null }, cache: cache(9000, model) }));
      expect(v).toMatchObject({ complexity: 'small', spawnTier: null, mainDowngrade: null, handoff: false });
    }
  });

  it('a model of no known tier gets nothing', () => {
    expect(decideTrajectory(facts({ stats: small(), current: { model: 'some-gateway-model', effort: null } }))).toMatchObject({ spawnTier: null, mainDowngrade: null });
  });

  it('the prompt verdict is confirmed or lowered, never raised: a confident opus verdict does not lift a small task', () => {
    const v = decideTrajectory(facts({ stats: small(), promptVerdict: { tier: 'opus', confidence: 0.9 } }));
    expect(v?.spawnTier).toBe('sonnet');
    // ...and the heavy prompt keeps the main model out of the suggestions.
    expect(v?.mainDowngrade).toBeNull();
  });

  it('a medium task carries a confident verdict below the user\'s model over to subagents, an unsure one not at all', () => {
    const s = explored();
    expect(decideTrajectory(facts({ stats: s, promptVerdict: { tier: 'sonnet', confidence: 0.7 } }))?.spawnTier).toBe('sonnet');
    expect(decideTrajectory(facts({ stats: s, promptVerdict: { tier: 'sonnet', confidence: 0.4 } }))?.spawnTier).toBeNull();
    // A verdict of the cheapest tier is not carried below Sonnet.
    expect(decideTrajectory(facts({ stats: s, promptVerdict: { tier: 'haiku', confidence: 0.9 } }))?.spawnTier).toBe('sonnet');
    // The user is on opus: an opus verdict is no ceiling.
    expect(decideTrajectory(facts({ stats: s, promptVerdict: { tier: 'opus', confidence: 0.9 } }))?.spawnTier).toBeNull();
    // On fable, a confident opus verdict is a tier below the user's.
    const fable = 'claude-fable-5-1';
    expect(decideTrajectory(facts({ stats: s, current: { model: fable, effort: null }, cache: cache(9000, fable), promptVerdict: { tier: 'opus', confidence: 0.9 } }))?.spawnTier).toBe('opus');
  });
});

describe('decideTrajectory: the main model downgrade and its break-even', () => {
  it('a small task on a small cache pays the rewrite back within a step or two', () => {
    const d = decideTrajectory(facts({ stats: small(), cache: cache(9000) }))?.mainDowngrade;
    expect(d?.to).toBe('sonnet');
    expect(d?.breakEvenSteps).toBeGreaterThanOrEqual(1);
    expect(d?.breakEvenSteps).toBeLessThanOrEqual(3);
    expect(d?.perStepUsd).toBeGreaterThan(0);
    expect(d?.savingUsd).toBeGreaterThan(0);
  });

  it('the bigger the cache, the longer it takes: a 150k prefix does not pay back inside the task', () => {
    expect(decideTrajectory(facts({ stats: small(), cache: cache(150_000) }))?.mainDowngrade).toBeNull();
  });

  it('a cold cache costs nothing to rewrite', () => {
    const cold: LineageState = { ...cache(150_000), lastAt: NOW - 3_600_000 };
    expect(decideTrajectory(facts({ stats: small(), cache: cold }))?.mainDowngrade?.breakEvenSteps).toBe(1);
  });

  it('break-even grows with the prefix', () => {
    const at = (t: number): number => decideTrajectory(facts({ stats: small(), cache: cache(t) }))?.mainDowngrade?.breakEvenSteps ?? Number.POSITIVE_INFINITY;
    expect(at(30_000)).toBeGreaterThan(at(9000));
  });

  it('none without a cache to read the prefix from, and none for a medium task', () => {
    expect(decideTrajectory(facts({ stats: small(), cache: undefined }))?.mainDowngrade).toBeNull();
    expect(decideTrajectory(facts({ stats: explored() }))?.mainDowngrade).toBeNull();
  });

  it('none where the id of Sonnet is not ours to name (a cloud id)', () => {
    const model = 'us.anthropic.claude-opus-5-5-v1:0';
    expect(decideTrajectory(facts({ stats: small(), current: { model, effort: null }, cache: cache(9000, model) }))?.mainDowngrade).toBeNull();
  });
});

describe('decideTrajectory: handoff', () => {
  it('after exploring, with a long context to leave behind and no edit yet', () => {
    const v = decideTrajectory(facts({ stats: explored(), cache: cache(120_000) }));
    expect(v?.complexity).toBe('medium');
    expect(v?.handoff).toBe(true);
    expect(v?.handoffSavingUsd).toBeGreaterThan(0);
    expect(v?.reasons).toContain('context: 120000');
  });

  it('not once the code is being written, on a short context, or on sonnet', () => {
    expect(decideTrajectory(facts({ stats: small(), cache: cache(120_000) }))?.handoff).toBe(false);
    expect(decideTrajectory(facts({ stats: explored(), cache: cache(9000) }))?.handoff).toBe(false);
    expect(decideTrajectory(facts({ stats: explored(), current: { model: SONNET, effort: null }, cache: cache(120_000, SONNET) }))?.handoff).toBe(false);
  });

  it('a plan-first prompt verdict is enough exploring', () => {
    const one = explored(1);
    expect(decideTrajectory(facts({ stats: one, cache: cache(120_000) }))?.handoff).toBe(false);
    expect(decideTrajectory(facts({ stats: one, cache: cache(120_000), promptVerdict: { tier: 'opus', confidence: 0.5, planFirst: true } }))?.handoff).toBe(true);
  });
});
