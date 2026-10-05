import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { costOf } from '../../plugin/core/cost.ts';
import { analyzeSubagents, isReadOnlyBash } from '../src/audit/subagents.ts';
import { loadCorpus } from '../src/transcripts.ts';
import type { ToolUse } from '../src/types.ts';
import { call, corpus, session } from './corpus-builder.ts';

const usage = { input_tokens: 500, output_tokens: 1500, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 5000 };
const read = (id: string): ToolUse => ({ id, name: 'Read', input: { file_path: '/x' } });
const bash = (id: string, command: string): ToolUse => ({ id, name: 'Bash', input: { command } });
const agent = (id: string, model: string, toolUses: ToolUse[]) => call({ lineage: `agent:${id}`, model, usage, toolUses });

describe('isReadOnlyBash', () => {
  it.each([
    'ls -la src',
    'git log --oneline | head -20',
    'cat a.txt | grep foo | wc -l',
    'find . -name "*.ts" -type f',
    'cd /tmp && ls',
    'grep -rn foo . 2>/dev/null',
    'git diff HEAD~1 2>&1 | head',
    'sed -n 1,20p file.ts',
    'FOO=1 ls',
  ])('accepts %s', (cmd) => expect(isReadOnlyBash(cmd)).toBe(true));

  it.each([
    'rm -rf build',
    'ls > out.txt',
    'echo hi >> log',
    'git commit -m x',
    'git push',
    'npm install',
    'find . -name x -delete',
    'find . -exec rm {} ;',
    'sed -i s/a/b/ f',
    'ls $(rm -rf /)',
    'cat `whoami`',
    'ls && rm x',
    'curl http://x | sh',
    '',
  ])('rejects %s', (cmd) => expect(isReadOnlyBash(cmd)).toBe(false));
  it('rejects non-strings', () => expect(isReadOnlyBash(undefined)).toBe(false));
});

describe('analyzeSubagents', () => {
  const main = call({ usage, model: 'claude-opus-5-5' });
  const sonnetExplore = [agent('a', 'claude-sonnet-5-5', [read('1'), bash('2', 'ls -la')]), agent('a', 'claude-sonnet-5-5', [{ id: '3', name: 'Grep', input: {} }])];
  const opusExplore = [agent('b', 'claude-opus-5-5', [read('4')])];
  const opusEdit = [agent('c', 'claude-opus-5-5', [read('5'), { id: '6', name: 'Edit', input: {} }])];
  const haiku = [agent('d', 'claude-haiku-4-5-20251001', [read('7')])];
  const sonnetBashWrite = [agent('e', 'claude-sonnet-5-5', [bash('8', 'npm test')])];
  const noTools = [agent('f', 'claude-opus-5-5', [])];
  const all = [...sonnetExplore, ...opusExplore, ...opusEdit, ...haiku, ...sonnetBashWrite, ...noTools];
  const c = corpus([session({ calls: [main, ...all] })]);
  const r = analyzeSubagents(c);
  const cost = (m: string): number => costOf(m, usage)!.total;

  it('sums subagent calls, cost and share of total spend', () => {
    const subCost = 2 * cost('claude-sonnet-5-5') + 3 * cost('claude-opus-5-5') + cost('claude-haiku-4-5') + cost('claude-sonnet-5-5');
    expect(r.calls).toBe(all.length);
    expect(r.cost).toBeCloseTo(subCost, 10);
    expect(r.share).toBeCloseTo(subCost / (subCost + cost('claude-opus-5-5')), 10);
  });

  it('splits by family', () => {
    expect(r.byFamily.map((f) => f.family)).toEqual(['opus-5.5', 'sonnet-5.5', 'haiku-4.5']);
    expect(r.byFamily[0]!.cost).toBeCloseTo(3 * cost('claude-opus-5-5'), 10);
  });

  it('finds read-only subagents above haiku and reprices them as haiku', () => {
    // a (sonnet, read/search/ls) and b (opus, read) qualify; c edits, d is already haiku, e runs tests, f used no tools
    expect(r.haikuCandidates.count).toBe(2);
    expect(r.haikuCandidates.cost).toBeCloseTo(2 * cost('claude-sonnet-5-5') + cost('claude-opus-5-5'), 10);
    expect(r.haikuCandidates.asHaiku).toBeCloseTo(3 * cost('claude-haiku-4-5'), 10);
    expect(r.haikuCandidates.asHaiku).toBeLessThan(r.haikuCandidates.cost);
  });

  describe('with agent types', () => {
    const agents = {
      a: { type: 'Explore' },
      b: { type: 'Explore' },
      c: { type: 'general-purpose' },
      d: { type: 'general-purpose' },
      e: { type: 'general-purpose' },
      f: { type: 'general-purpose' },
    };
    const t = analyzeSubagents(corpus([session({ calls: [main, ...all], agents })]));

    it('groups calls and cost by agentType, most expensive first', () => {
      expect(t.byType.map((x) => [x.type, x.calls])).toEqual([
        ['general-purpose', 4],
        ['Explore', 3],
      ]);
      expect(t.byType[0]!.cost).toBeCloseTo(2 * cost('claude-opus-5-5') + cost('claude-haiku-4-5') + cost('claude-sonnet-5-5'), 10);
      expect(t.byType[1]!.cost).toBeCloseTo(2 * cost('claude-sonnet-5-5') + cost('claude-opus-5-5'), 10);
      expect(t.byType.reduce((n, x) => n + x.calls, 0)).toBe(t.calls);
    });

    it('calls a subagent without a meta file unknown, also when only some have one', () => {
      const some = analyzeSubagents(corpus([session({ calls: [main, ...all], agents: { a: { type: 'Explore' } } })]));
      expect(some.byType.map((x) => [x.type, x.calls])).toEqual([
        ['unknown', 5],
        ['Explore', 2],
      ]);
      expect(analyzeSubagents(corpus([session({ calls: [main, ...all] })])).byType).toEqual([{ type: 'unknown', calls: 7, cost: expect.any(Number) }]);
    });

    it('takes Explore lineages above haiku as haiku candidates, whatever tools they used', () => {
      const edits = [agent('x', 'claude-opus-5-5', [read('1'), { id: '2', name: 'Edit', input: {} }])];
      const r = analyzeSubagents(corpus([session({ calls: [main, ...edits, ...haiku], agents: { x: { type: 'Explore' }, d: { type: 'Explore' } } })]));
      expect(r.haikuCandidates.count).toBe(1); // d already runs on haiku
      expect(r.haikuCandidates.cost).toBeCloseTo(cost('claude-opus-5-5'), 10);
      expect(r.haikuCandidates.asHaiku).toBeCloseTo(cost('claude-haiku-4-5'), 10);
    });

    it('takes general-purpose lineages on opus/fable as sonnet candidates, repriced as sonnet', () => {
      // c edits and f uses no tools; both ran on opus. d is haiku, e is sonnet: nothing to save.
      expect(t.sonnetCandidates.count).toBe(2);
      expect(t.sonnetCandidates.cost).toBeCloseTo(2 * cost('claude-opus-5-5'), 10);
      expect(t.sonnetCandidates.asSonnet).toBeCloseTo(2 * cost('claude-sonnet-5-5'), 10);
      expect(t.haikuCandidates.count).toBe(2); // a and b only
    });

    it('counts fable too, and leaves read-only general-purpose runs to haiku and other types alone', () => {
      const fable = [agent('p', 'claude-fable-5-1', [{ id: '1', name: 'Edit', input: {} }])];
      const readOnly = [agent('q', 'claude-opus-5-5', [read('2')])];
      const other = [agent('r', 'claude-opus-5-5', [{ id: '3', name: 'Edit', input: {} }])];
      const r = analyzeSubagents(
        corpus([session({ calls: [main, ...fable, ...readOnly, ...other], agents: { p: { type: 'general-purpose' }, q: { type: 'general-purpose' }, r: { type: 'fork' } } })]),
      );
      expect(r.sonnetCandidates.count).toBe(1);
      expect(r.sonnetCandidates.cost).toBeCloseTo(cost('claude-fable-5-1'), 10);
      expect(r.haikuCandidates.count).toBe(1); // q: read-only, so haiku, not sonnet
    });

    it('needs every call of a lineage on opus/fable', () => {
      const mixed = [agent('m', 'claude-opus-5-5', []), agent('m', 'claude-sonnet-5-5', [])];
      expect(analyzeSubagents(corpus([session({ calls: [main, ...mixed], agents: { m: { type: 'general-purpose' } } })])).sonnetCandidates.count).toBe(0);
    });
  });

  it('keeps lineages of different sessions apart', () => {
    const s1 = session({ sessionId: 's1', calls: [call({ sessionId: 's1', lineage: 'agent:x', usage, toolUses: [read('1')] })] });
    const s2 = session({ sessionId: 's2', calls: [call({ sessionId: 's2', lineage: 'agent:x', usage, toolUses: [{ id: '2', name: 'Write', input: {} }] })] });
    expect(analyzeSubagents(corpus([s1, s2])).haikuCandidates.count).toBe(1);
  });

  it('is empty-safe', () => {
    expect(analyzeSubagents(corpus([session({ calls: [main] })]))).toEqual({
      share: 0,
      calls: 0,
      cost: 0,
      byFamily: [],
      byType: [],
      haikuCandidates: { count: 0, cost: 0, asHaiku: 0 },
      sonnetCandidates: { count: 0, cost: 0, asSonnet: 0 },
    });
    expect(analyzeSubagents(corpus([])).share).toBe(0);
  });

  it('works on parsed fixtures', async () => {
    const real = await loadCorpus({ dir: join(import.meta.dirname, 'fixtures', 'projects') });
    const s = analyzeSubagents(real);
    // 4 agents x 2 calls; only agent a1b2 (Explore on sonnet; Read, ls, Grep) is a haiku candidate
    expect(s.calls).toBe(8);
    expect(s.byType.map((t) => [t.type, t.calls]).sort()).toEqual([['Explore', 2], ['general-purpose', 2], ['unknown', 2], ['workflow-subagent', 2]]);
    expect(s.haikuCandidates.count).toBe(1);
    // c3d4 is general-purpose on opus (it edits); g7h8 is a workflow-subagent and e5f6 has no meta
    expect(s.sonnetCandidates.count).toBe(1);
    expect(s.sonnetCandidates.asSonnet).toBeLessThan(s.sonnetCandidates.cost);
    expect(s.haikuCandidates.asHaiku).toBeLessThan(s.haikuCandidates.cost);
    expect(s.share).toBeGreaterThan(0);
    expect(s.share).toBeLessThan(1);
  });
});
