import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costOf } from '../../plugin/core/cost.ts';
import { sessionCost } from '../src/audit/spend.ts';
import { loadCorpus, resolveProjectsDir } from '../src/transcripts.ts';
import type { Corpus, SessionData } from '../src/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'projects');
const FRESH = new Date('2026-09-10T00:00:00Z');
const OLD = new Date('2026-06-02T00:00:00Z');

let dir: string;
let corpus: Corpus;

const sess = (c: Corpus, id: string): SessionData => {
  const s = c.sessions.find((x) => x.sessionId === id);
  if (!s) throw new Error(`missing session ${id}`);
  return s;
};

function touchAll(root: string, when: Date): void {
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) utimesSync(join(e.parentPath, e.name), when, when);
  }
}

beforeAll(async () => {
  // Fixtures are copied so that file mtimes are deterministic (git does not keep them).
  dir = mkdtempSync(join(tmpdir(), 'agento-fx-'));
  cpSync(FIXTURES, dir, { recursive: true });
  touchAll(dir, FRESH);
  utimesSync(join(dir, '-tmp-old', 'sess-old.jsonl'), OLD, OLD);
  corpus = await loadCorpus({ dir });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveProjectsDir', () => {
  it('prefers the flag, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = '/cfg';
      expect(resolveProjectsDir('/flag')).toBe('/flag');
      expect(resolveProjectsDir()).toBe(join('/cfg', 'projects'));
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(resolveProjectsDir()).toBe(join(homedir(), '.claude', 'projects'));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});

describe('loadCorpus on fixtures', () => {
  it('finds main files and subagent files (including nested workflow agents), skips journals', () => {
    expect(corpus.stats.files).toBe(9);
    expect(corpus.sessions.map((s) => s.sessionId).sort()).toEqual(['sess-cmds', 'sess-idle', 'sess-main', 'sess-old', 'sess-resumed']);
    const lineages = new Set(sess(corpus, 'sess-main').calls.map((c) => c.lineage));
    expect([...lineages].sort()).toEqual(['agent:a1b2', 'agent:c3d4', 'agent:e5f6', 'agent:g7h8', 'main']);
  });

  it('reads agent-<id>.meta.json next to subagent files, nested ones included', () => {
    expect(sess(corpus, 'sess-main').agents).toEqual({
      a1b2: { type: 'Explore', description: 'find the config loader' },
      c3d4: { type: 'general-purpose', description: 'apply the refactor' },
      g7h8: { type: 'workflow-subagent' },
    }); // e5f6 has no meta file
    expect(sess(corpus, 'sess-idle').agents).toEqual({});
  });

  it('ignores broken meta files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agento-meta-'));
    try {
      const row = (id: string): string =>
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-05T10:00:00.000Z', requestId: id, message: { id, model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1 } } });
      mkdirSync(join(root, 'p', 's1', 'subagents'), { recursive: true });
      writeFileSync(join(root, 'p', 's1.jsonl'), row('m0'));
      for (const [id, meta] of [['x1', '{not json'], ['x2', '{"agentType":42}'], ['x3', '[]'], ['x4', '{"agentType":"Plan","description":"' + 'd'.repeat(500) + '"}']] as const) {
        writeFileSync(join(root, 'p', 's1', 'subagents', `agent-${id}.jsonl`), row(id));
        writeFileSync(join(root, 'p', 's1', 'subagents', `agent-${id}.meta.json`), meta);
      }
      writeFileSync(join(root, 'p', 's1', 'subagents', 'agent-x5.jsonl'), row('x5'));
      const c = await loadCorpus({ dir: root });
      expect(Object.keys(c.sessions[0]!.agents)).toEqual(['x4']);
      expect(c.sessions[0]!.agents.x4).toEqual({ type: 'Plan', description: 'd'.repeat(200) });
      expect(c.sessions[0]!.calls).toHaveLength(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates rows of one request: last row wins, tool uses are merged', () => {
    const main = sess(corpus, 'sess-main').calls.filter((c) => c.lineage === 'main');
    expect(main.map((c) => c.messageId)).toEqual(['msg_a1', 'msg_a2', 'msg_a4']);
    const a1 = main[0]!;
    expect(a1.requestId).toBe('req_a1');
    expect(a1.usage.output_tokens).toBe(150);
    expect(a1.usage.cache_creation_input_tokens).toBe(1000);
    expect(a1.toolUses.map((t) => t.name)).toEqual(['Read', 'Grep']);
    expect(a1.stopReason).toBe('tool_use');
    expect(a1.effort).toBe('high');
    expect(a1.isSidechain).toBe(false);
    // 2 repeated rows of msg_a1 + 1 of the first subagent request + 1 row copied into sess-resumed
    expect(corpus.stats.duplicateRows).toBe(4);
  });

  it('keeps cache TTL split and fast speed', () => {
    const main = sess(corpus, 'sess-main').calls.filter((c) => c.lineage === 'main');
    const a4 = main.find((c) => c.messageId === 'msg_a4')!;
    expect(a4.usage.cache_creation?.ephemeral_1h_input_tokens).toBe(2000);
    const a2 = main.find((c) => c.messageId === 'msg_a2')!;
    expect(a2.speed).toBe('fast');
    expect(a2.usage.speed).toBe('fast');
    expect(costOf(a2.model, a2.usage)!.total).toBeGreaterThan(costOf(a2.model, { ...a2.usage, speed: null })!.total);
  });

  it('drops <synthetic> rows and counts them as unknown; counts bad lines', () => {
    expect(sess(corpus, 'sess-main').calls.some((c) => c.model === '<synthetic>')).toBe(false);
    expect(corpus.stats.unknownModelCalls).toBe(1);
    expect(corpus.stats.badLines).toBe(1);
    expect(corpus.stats.lines).toBeGreaterThan(60);
  });

  it('links subagent files to the parent session and takes the lineage from the file name', () => {
    const subs = sess(corpus, 'sess-main').calls.filter((c) => c.lineage !== 'main');
    expect(subs.every((c) => c.sessionId === 'sess-main' && c.isSidechain)).toBe(true);
    expect(subs.filter((c) => c.lineage === 'agent:g7h8')).toHaveLength(2);
  });

  it('reads project, cwd and branch', () => {
    const s = sess(corpus, 'sess-idle');
    expect(s.project).toBe('-tmp-demo-app');
    expect(s.cwd).toBe('/tmp/demo-app');
    expect(s.gitBranch).toBe('feature/x');
  });

  it('keeps only human prompts; meta, notifications and tool results are not prompts', () => {
    expect(sess(corpus, 'sess-main').prompts.map((p) => p.text)).toEqual(['fixture prompt one']);
    const cmds = sess(corpus, 'sess-cmds').prompts;
    expect(cmds.map((p) => [p.text, p.isSlashCommand])).toEqual([
      ['fixture hello', false],
      ['/model', true],
      ['fixture second prompt', false],
      ['/effort', true],
      ['fixture third prompt', false],
      ['/clear', true],
      ['/review fixture-args', true],
      ['<pasted_content>fixture pasted</pasted_content> and a question', false],
    ]);
    // compact summary row and interrupt notice are not prompts
    expect(sess(corpus, 'sess-idle').prompts.map((p) => p.text)).toEqual(['fixture idle start', 'fixture after auto compact', '/compact']);
  });

  it('collects tool results with is_error and truncation', () => {
    const results = sess(corpus, 'sess-main').toolResults;
    expect(results).toHaveLength(7);
    const err = results.find((r) => r.toolUseId === 'tu_2')!;
    expect(err.isError).toBe(true);
    expect(err.text).toHaveLength(2000);
    expect(results.find((r) => r.toolUseId === 'tu_1')).toMatchObject({ isError: false, text: 'ok', lineage: 'main' });
    expect(results.find((r) => r.toolUseId === 'sa_1')!.lineage).toBe('agent:a1b2');
  });

  it('shortens huge tool inputs', () => {
    const grep = sess(corpus, 'sess-main').calls[0]!.toolUses.find((t) => t.name === 'Grep')!;
    expect((grep.input as { pattern: string }).pattern).toHaveLength(1000);
  });

  it('turns compaction, away, /model, /effort, /clear into markers', () => {
    expect(sess(corpus, 'sess-idle').markers.map((m) => [m.kind, m.detail])).toEqual([
      ['away', undefined],
      ['compact', 'auto'],
      ['compact', 'manual'],
    ]);
    expect(sess(corpus, 'sess-cmds').markers.map((m) => [m.kind, m.detail])).toEqual([
      ['model', 'Sonnet 5.5'],
      ['effort', 'medium'],
      ['model', undefined],
      ['clear', undefined],
    ]);
  });

  it('drops requests copied into a resumed session', () => {
    expect(sess(corpus, 'sess-resumed').calls.map((c) => c.messageId)).toEqual(['msg_r1']);
    expect(sess(corpus, 'sess-cmds').calls.map((c) => c.messageId)).toContain('msg_c2');
  });

  it('takes the last cost-state as reportedCostUSD', () => {
    const main = sess(corpus, 'sess-main');
    expect(main.reportedCostUSD).toBeCloseTo(sessionCost(main) * 1.04, 4);
    expect(sess(corpus, 'sess-resumed').reportedCostUSD).toBeUndefined();
  });

  it('sorts calls and sessions by time', () => {
    for (const s of corpus.sessions) {
      const ts = s.calls.map((c) => c.ts);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
      expect(s.firstTs).toBeLessThanOrEqual(s.lastTs);
    }
    const firsts = corpus.sessions.map((s) => s.firstTs);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  });
});

describe('loadCorpus filters', () => {
  it('skips files older than since by mtime and calls older than since by ts', async () => {
    const c = await loadCorpus({ dir, since: Date.parse('2026-09-02T00:00:00Z') });
    expect(c.sessions.map((s) => s.sessionId).sort()).toEqual(['sess-cmds', 'sess-idle', 'sess-resumed']);
    expect(c.stats.files).toBe(8); // sess-old is skipped by mtime without being read
  });

  it('cuts a session in the middle and then no longer trusts its reported cost', async () => {
    const c = await loadCorpus({ dir, since: Date.parse('2026-09-02T11:30:00Z') });
    const idle = sess(c, 'sess-idle');
    expect(idle.calls.map((x) => x.messageId)).toEqual(['msg_i4', 'msg_i5']);
    expect(idle.reportedCostUSD).toBeUndefined();
    expect(idle.markers.map((m) => m.kind)).toEqual(['away', 'compact', 'compact']);
  });

  it('filters by project substring', async () => {
    const c = await loadCorpus({ dir, project: 'LIB' });
    expect(c.sessions.map((s) => s.sessionId).sort()).toEqual(['sess-cmds', 'sess-resumed']);
    expect(c.stats.files).toBe(2);
  });

  it('reports progress', async () => {
    const seen: Array<[number, number]> = [];
    await loadCorpus({ dir, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen).toHaveLength(9);
    expect(seen.at(-1)).toEqual([9, 9]);
  });

  it('throws on a missing directory', async () => {
    await expect(loadCorpus({ dir: join(dir, 'nope') })).rejects.toThrow(/not found/);
  });
});

describe('robustness and performance', () => {
  const row = (type: string, extra: object): string => JSON.stringify({ type, sessionId: 's', timestamp: '2026-09-05T10:00:00.000Z', uuid: 'u', ...extra });

  it('survives garbage lines, unknown fields and truncates long prompts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agento-rb-'));
    try {
      mkdirSync(join(root, 'p'));
      const lines = [
        'not json',
        '[1,2,3]',
        '{"type":"assistant","timestamp":"nope","message":{"usage":{}}}',
        row('assistant', { requestId: 'r', message: { id: 'm', model: 'claude-opus-5-5', content: 'weird', usage: { input_tokens: 3, mystery: { a: 1 } } }, brandNewField: [1] }),
        row('user', { message: { role: 'user', content: 'x'.repeat(5000) }, origin: { kind: 'human' } }),
        row('totally-new-type', { foo: 1 }),
        '',
      ];
      writeFileSync(join(root, 'p', 's.jsonl'), lines.join('\n'));
      const c = await loadCorpus({ dir: root });
      expect(c.stats.badLines).toBe(3);
      expect(c.sessions[0]!.calls).toHaveLength(1);
      expect(c.sessions[0]!.calls[0]!.usage.input_tokens).toBe(3);
      expect(c.sessions[0]!.prompts[0]!.text).toHaveLength(4000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads 1000 generated files in under 10 s', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agento-perf-'));
    try {
      const assistant = (i: number, j: number): string =>
        row('assistant', {
          requestId: `r${i}-${j}`,
          message: { id: `m${i}-${j}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'y'.repeat(200) }], usage: { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 } },
        });
      for (let p = 0; p < 20; p++) {
        mkdirSync(join(root, `proj-${p}`));
        for (let f = 0; f < 50; f++) {
          const i = p * 50 + f;
          const lines: string[] = [];
          for (let j = 0; j < 40; j++) lines.push(assistant(i, j), assistant(i, j));
          writeFileSync(join(root, `proj-${p}`, `s${i}.jsonl`), lines.join('\n'));
        }
      }
      const t = Date.now();
      const c = await loadCorpus({ dir: root });
      expect(Date.now() - t).toBeLessThan(10_000);
      expect(c.stats.files).toBe(1000);
      expect(c.sessions.reduce((n, s) => n + s.calls.length, 0)).toBe(40_000);
      expect(c.stats.duplicateRows).toBe(40_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
