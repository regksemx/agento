import { describe, expect, it } from 'vitest';
import type { AgentoLedger } from '../types';
import { applyCredit, applyDecision, applyHandoff, applyHint, applyStep, dropMainLineage, emptyLedger, foldDay, hintsOf, MAX_AGENT_LINEAGES, MAX_ROUTED, normalizeDay, savedOf, type StepInput } from './ledger.ts';

const T0 = 1_760_000_000_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const usage = { input_tokens: 0, output_tokens: 1500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 3000 };
const step = (model: string, over: Partial<StepInput> = {}): StepInput => ({ ts: T0, lineage: 'main', model, effort: 'high', usage, mode: 'balanced', isSubscription: false, sevenDayPct: null, ...over });

describe('credit: what agento changed at a clean point is credited, as an estimate', () => {
  it('main steps on the tier agento moved to are credited against the model the user left', () => {
    let l: AgentoLedger | undefined = applyStep(undefined, step(OPUS));
    l = applyCredit(l, { mechanism: 'autopilot', fromModel: OPUS, model: 'sonnet', since: T0 }, T0, 'balanced', false);
    l = applyStep(l, step(SONNET, { ts: T0 + 1000 }));
    const s = l.recent[l.recent.length - 1];
    expect(s?.mechanism).toBe('autopilot');
    expect(s?.savedEstimate).toBeCloseTo(0.065 - 0.0425, 9);
    expect(l.savedEstimate.autopilot).toBeCloseTo(0.0225, 9);
    expect(l.savedEstimate.suggestions).toBe(0);
    expect(l.credit?.mechanism).toBe('autopilot');
  });

  it('suggestion-accepted and handoff land in their own buckets', () => {
    let l = applyStep(undefined, step(OPUS));
    l = applyCredit(l, { mechanism: 'suggestion-accepted', fromModel: OPUS, model: 'sonnet', since: T0 }, T0, 'balanced', false);
    l = applyStep(l, step(SONNET));
    l = applyCredit(l, { mechanism: 'handoff', fromModel: OPUS, model: 'sonnet', since: T0 }, T0, 'balanced', false);
    l = applyStep(l, step(SONNET));
    expect(l.savedEstimate.suggestions).toBeCloseTo(0.0225, 9);
    expect(l.savedEstimate.handoff).toBeCloseTo(0.0225, 9);
  });

  it('the credit ends when the user goes to another tier; nothing is credited after', () => {
    let l = applyStep(undefined, step(OPUS));
    l = applyCredit(l, { mechanism: 'autopilot', fromModel: OPUS, model: 'sonnet', since: T0 }, T0, 'balanced', false);
    l = applyStep(l, step(OPUS)); // the user switched back to opus themselves
    expect(l.credit).toBeNull();
    expect(l.recent[l.recent.length - 1]?.mechanism).toBeNull();
    l = applyStep(l, step(SONNET));
    expect(l.savedEstimate.autopilot).toBe(0);
  });

  it('subagent steps are never credited by a main-thread change', () => {
    let l = applyStep(undefined, step(OPUS));
    l = applyCredit(l, { mechanism: 'autopilot', fromModel: OPUS, model: 'sonnet', since: T0 }, T0, 'balanced', false);
    l = applyStep(l, step(SONNET, { lineage: 'agent:a1' }));
    expect(l.recent[l.recent.length - 1]?.mechanism).toBeNull();
    expect(l.credit).not.toBeNull();
  });

  it('an unknown model prices nothing and credits nothing', () => {
    let l = applyStep(undefined, step(OPUS));
    l = applyCredit(l, { mechanism: 'autopilot', fromModel: 'gateway-x', model: 'sonnet', since: T0 }, T0, 'balanced', false);
    l = applyStep(l, step(SONNET));
    expect(l.savedEstimate.autopilot).toBe(0);
  });
});

describe('handoff record', () => {
  it('the executor\'s first main step fills in its context size, once', () => {
    let l = applyStep(undefined, step(OPUS));
    l = applyHandoff(l, { ts: T0 + 10, planPath: '.agento/plans/p.md', plannerTokens: 142_000, executorTokens: null }, 'balanced', false);
    l = applyStep(l, step(SONNET, { ts: T0 + 20, usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 8000, input_tokens: 500 } }));
    expect(l.handoff?.executorTokens).toBe(8500);
    l = applyStep(l, step(SONNET, { ts: T0 + 30 }));
    expect(l.handoff?.executorTokens).toBe(8500);
  });
});

describe('hints and /clear', () => {
  it('counts', () => {
    let l = applyHint(undefined, 'shown', T0, 'balanced', false);
    l = applyHint(l, 'shown', T0, 'balanced', false);
    l = applyHint(l, 'accepted', T0, 'balanced', false);
    expect(hintsOf(l)).toEqual({ shown: 2, accepted: 1, dismissed: 0, auto: 0 });
  });
  it('an older ledger without the new fields still reads', () => {
    const old = { ...emptyLedger(T0, 'balanced', false) } as Partial<AgentoLedger>;
    delete old.hints;
    delete old.credit;
    expect(hintsOf(old as AgentoLedger)).toEqual({ shown: 0, accepted: 0, dismissed: 0, auto: 0 });
    expect(savedOf({ savedEstimate: { spawnRouting: 1 } as never })).toEqual({ spawnRouting: 1, suggestions: 0, handoff: 0, autopilot: 0, prune: 0 });
    const l = applyStep(old as AgentoLedger, step(OPUS));
    expect(l.steps).toBe(1);
  });
  it('dropMainLineage forgets only the main cache', () => {
    let l = applyStep(undefined, step(OPUS));
    l = applyStep(l, step('claude-haiku-4-5', { lineage: 'agent:a1' }));
    expect(Object.keys(dropMainLineage(l).lineages)).toEqual(['agent:a1']);
    expect(dropMainLineage(dropMainLineage(l))).toEqual(dropMainLineage(l));
  });
});

describe('day aggregates', () => {
  it('credit buckets fold per mechanism; an old day gains the new fields', () => {
    let l = applyStep(undefined, step(OPUS));
    l = applyCredit(l, { mechanism: 'autopilot', fromModel: OPUS, model: 'sonnet', since: T0 }, T0, 'balanced', false);
    l = applyStep(l, step(SONNET));
    const d = foldDay({ steps: 1, cost: 1, baselineCost: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, byModel: {}, savedEstimate: { spawnRouting: 2, suggestions: 0, handoff: 0 }, routedSpawns: 0, loopSignals: 0 }, l.recent[l.recent.length - 1]!);
    expect(d.savedEstimate.spawnRouting).toBe(2);
    expect(d.savedEstimate.autopilot).toBeCloseTo(0.0225, 9);
    expect(d.hintsShown).toBe(0);
    expect(normalizeDay('junk').autopilotActions).toBe(0);
  });
});

describe('session state stays small in a long session (it is copied on every step)', () => {
  it('keeps the cache lines of the most recent subagents only, and always the main one', () => {
    let l = applyStep(undefined, step(OPUS));
    for (let i = 0; i < MAX_AGENT_LINEAGES + 30; i += 1) l = applyStep(l, step(SONNET, { lineage: `agent:a${i}`, ts: T0 + i }));
    const keys = Object.keys(l.lineages);
    expect(keys).toHaveLength(MAX_AGENT_LINEAGES + 1);
    expect(keys).toContain('main');
    expect(keys).toContain(`agent:a${MAX_AGENT_LINEAGES + 29}`);
    expect(keys).not.toContain('agent:a0');
    // A line that steps again is the newest, and main is still where it was.
    l = applyStep(l, step(SONNET, { lineage: 'agent:a30' }));
    expect(Object.keys(l.lineages).at(-1)).toBe('agent:a30');
    expect(l.lineages.main?.model).toBe(OPUS);
  });

  it('keeps the routing decisions of the most recent subagents only', () => {
    let l: AgentoLedger | undefined;
    for (let i = 0; i < MAX_ROUTED + 10; i += 1) {
      l = applyDecision(l, { ts: T0 + i, agentId: `a${i}`, subagentType: 'Explore', parentModel: OPUS, model: 'haiku', reason: 'explore-agent', mechanism: 'spawn-routing' }, 'balanced', false);
    }
    expect(Object.keys(l?.routed ?? {})).toHaveLength(MAX_ROUTED);
    expect(l?.routed.a0).toBeUndefined();
    expect(l?.routed[`a${MAX_ROUTED + 9}`]?.model).toBe('haiku');
  });
});
