import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRecords, writeDataset } from '../src/dataset/build.ts';
import { buildSessionRecords, isCorrection, isTestCommand, projectLabel, taskId } from '../src/dataset/features.ts';
import { L0_THRESHOLDS, difficultyScore, isLookupPrompt, l0Label } from '../src/dataset/l0.ts';
import { renderDatasetSummary } from '../src/dataset/render.ts';
import { summarize } from '../src/dataset/summary.ts';
import { agentoHome, defaultOutPath, summaryPathFor } from '../src/dataset/write.ts';
import type { TaskObserved, TaskRecord } from '../src/dataset/types.ts';
import { call, corpus, marker, MIN, prompt, session, step, T0, toolResult } from './corpus-builder.ts';

const use = (id: string, name: string, input: Record<string, unknown>) => ({ id, name, input });

function observed(p: Partial<TaskObserved> = {}): TaskObserved {
  return {
    model: 'claude-opus-5-5',
    modelTier: 'opus',
    mainCalls: 10,
    subagentCalls: 0,
    subagentTypes: [],
    filesEdited: 1,
    linesChanged: 10,
    toolErrors: 0,
    testRuns: 0,
    testFailures: 0,
    sameEditRepeats: 0,
    userCorrections: 0,
    userInterrupts: 0,
    planMode: false,
    durationMs: 1000,
    outputTokens: 1000,
    cost: 1,
    ...p,
  };
}

describe('isCorrection', () => {
  it.each([
    'нет, не так',
    'Нет.',
    'это не то, что я просил',
    'неправильно, переделай',
    'откати это',
    'верни как было',
    'please revert that',
    'this is wrong',
    "that's not what I meant",
    'stop',
    '[Request interrupted by user]',
  ])('matches %s', (t) => expect(isCorrection(t)).toBe(true));

  it.each(['да, продолжай', 'ok, thanks', 'добавь тест', 'нетрудно', 'unwrongful', 'bus stopper', 'отлично', 'what is this'])('ignores %s', (t) =>
    expect(isCorrection(t)).toBe(false),
  );
});

describe('isTestCommand', () => {
  it.each(['npx vitest run', 'npm test', 'npm run test -- --watch', 'pnpm test', 'pytest -x tests/', 'cargo test', 'go test ./...', 'yarn test', './gradlew test', 'python -m pytest', 'cd x && jest --ci'])(
    'matches %s',
    (c) => expect(isTestCommand(c)).toBe(true),
  );
  it.each(['npm run build', 'ls tests/', 'git commit -m "add test"', 'cat contest.txt', 'tsc -p .'])('ignores %s', (c) => expect(isTestCommand(c)).toBe(false));
});

describe('buildSessionRecords', () => {
  const s = session({
    sessionId: 'sess-1',
    cwd: '/Users/someone/Projects/app',
    gitBranch: 'main',
    agents: { a1: { type: 'Explore' }, a2: { type: 'general-purpose' } },
    prompts: [
      prompt('Исправь баг в src/app.ts, ключ sk-ant-abcd1234efgh не трогай', T0),
      prompt('нет, не так', T0 + 2 * MIN),
      prompt('revert it', T0 + 3 * MIN),
      prompt('ok now add a test', T0 + 4 * MIN),
      prompt('and docs', T0 + 5 * MIN),
      prompt('and changelog', T0 + 6 * MIN),
      prompt('/model sonnet', T0 + 6 * MIN + 1000),
      prompt('как работает кэш?', T0 + 90 * MIN),
    ],
    calls: [
      step(T0 + 1 * MIN, 40_000, 2_000, 1_500, {
        effort: 'high',
        toolUses: [use('t1', 'Read', { file_path: '/p/src/app.ts' }), use('t2', 'Grep', { path: '/p/src/b.py', pattern: 'x' })],
      }),
      step(T0 + 2 * MIN, 42_000, 1_000, 500, {
        effort: 'high',
        toolUses: [
          use('t3', 'Edit', { file_path: '/p/src/app.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 2;' }),
          use('t4', 'Bash', { command: 'npx vitest run' }),
        ],
      }),
      step(T0 + 3 * MIN, 43_000, 1_000, 500, {
        effort: 'high',
        toolUses: [
          use('t5', 'Edit', { file_path: '/p/src/app.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 3;' }), // same place again
          use('t6', 'Write', { file_path: '/p/NOTES.md', content: 'a\nb\nc' }),
          use('t7', 'ExitPlanMode', { plan: 'x' }),
        ],
      }),
      step(T0 + 4 * MIN, 44_000, 1_000, 500, { effort: 'high', toolUses: [use('t8', 'Bash', { command: 'npm test' })] }),
      step(T0 + 3 * MIN + 5000, 10_000, 500, 300, { lineage: 'agent:a1' }),
      step(T0 + 3 * MIN + 6000, 10_000, 500, 300, { lineage: 'agent:a2' }),
      step(T0 + 3 * MIN + 7000, 10_000, 500, 300, { lineage: 'agent:zz' }),
      step(T0 + 91 * MIN, 5_000, 500, 200, { model: 'claude-haiku-4-5' }),
    ],
    toolResults: [
      toolResult('t4', T0 + 2 * MIN + 10_000, true, 'FAIL'),
      toolResult('t8', T0 + 4 * MIN + 10_000, false, 'ok'),
      toolResult('t3', T0 + 2 * MIN + 5_000, true, 'oops'),
      toolResult('x', T0 + 3 * MIN + 30_000, true, "The user doesn't want to proceed with this tool use."),
    ],
    markers: [],
  });

  const { records, hits } = buildSessionRecords(s);

  it('segments tasks like the audit does', () => {
    expect(records).toHaveLength(2);
    expect(records[0]!.startTs).toBe(T0);
    expect(records[1]!.context.startKind).toBe('idle');
    expect(records[0]!.context.startKind).toBe('first-prompt');
  });

  it('writes scrubbed text: first prompt plus up to 3 follow-ups, slash commands excluded', () => {
    const r = records[0]!;
    expect(r.text).toHaveLength(4);
    expect(r.text[0]).toBe('Исправь баг в src/app.ts, ключ [SECRET] не трогай');
    expect(r.text.slice(1)).toEqual(['нет, не так', 'revert it', 'ok now add a test']);
    expect(JSON.stringify(r)).not.toContain('sk-ant');
    expect(hits['api-key']).toBe(1);
  });

  it('truncates long prompts after scrubbing, never keeping part of a key', () => {
    const key = 'sk-ant-' + 'A1b2C3d4'.repeat(8);
    const sess = session({
      prompts: [prompt('x'.repeat(1495) + ' ' + key, T0), prompt('y'.repeat(2000), T0 + MIN)],
      calls: [step(T0 + 1000, 1000)],
    });
    const [r] = buildSessionRecords(sess).records;
    expect(r!.text[0]).toHaveLength(1500);
    expect(r!.text[0]!.endsWith(' [SEC')).toBe(true); // the replacement was cut, the key was not
    expect(JSON.stringify(r)).not.toContain('sk-ant');
    expect(r!.text[1]).toHaveLength(1500);
  });

  it('computes context', () => {
    const c = records[0]!.context;
    expect(c.contextTokensAtStart).toBe(42_000); // cache_read + cache_creation of the first main call
    expect(c.languages).toEqual(['python', 'typescript']);
    expect(c.hasGitBranch).toBe(true);
    expect(c.prevTaskWasHeavy).toBe(false);
    expect(records[1]!.context.prevTaskWasHeavy).toBe(true); // first task: corrections >= 2
    expect(records[1]!.context.languages).toEqual([]);
  });

  it('computes the observed trajectory', () => {
    const o = records[0]!.observed;
    expect(o).toMatchObject({
      model: 'claude-opus-5-5',
      modelTier: 'opus',
      effort: 'high',
      mainCalls: 4,
      subagentCalls: 3,
      subagentTypes: ['Explore', 'general-purpose', 'unknown'],
      filesEdited: 2,
      linesChanged: 2 + 1 + 2 + 1 + 3, // two Edits (old+new lines each) and a 3-line Write
      toolErrors: 3,
      testRuns: 2,
      testFailures: 1,
      sameEditRepeats: 1,
      userCorrections: 2,
      userInterrupts: 1,
      planMode: true,
    });
    expect(o.durationMs).toBe(4 * MIN - 0);
    expect(o.cost).toBeGreaterThan(0);
    expect(records[1]!.observed).toMatchObject({ modelTier: 'haiku', mainCalls: 1, planMode: false, userCorrections: 0 });
  });

  it('assigns L0 labels and the rules verdict, and no l1/l2 fields', () => {
    const r = records[0]!;
    expect(r).toMatchObject({ l0Tier: 'opus', l0Effort: 'high', labelSource: 'L0', v: 1 });
    expect(r.difficulty).toBeGreaterThan(0.3);
    expect(r.rulesVerdict).toMatchObject({ tier: expect.any(String), effort: expect.any(String) });
    expect(r).not.toHaveProperty('l1');
    expect(r).not.toHaveProperty('l2');
    const q = records[1]!;
    expect(q).toMatchObject({ l0Tier: 'haiku', l0Effort: 'low' });
  });

  it('uses a stable, non-reversible task id and a ~ project label', () => {
    expect(records[0]!.taskId).toBe(taskId('sess-1', T0));
    expect(records[0]!.taskId).toMatch(/^[0-9a-f]{16}$/);
    expect(records[0]!.taskId).not.toContain('sess');
    expect(taskId('sess-2', T0)).not.toBe(taskId('sess-1', T0));
    expect(records[0]!.project).toBe('~/Projects/app');
    expect(JSON.stringify(records)).not.toContain('/Users/someone');
  });
});

describe('start kinds', () => {
  it('detects compact and clear', () => {
    const s = session({
      prompts: [prompt('one', T0), prompt('/clear', T0 + 5 * MIN), prompt('two', T0 + 6 * MIN), prompt('three', T0 + 20 * MIN)],
      markers: [marker('clear', T0 + 5 * MIN), marker('compact', T0 + 15 * MIN)],
      calls: [step(T0 + MIN, 1000), step(T0 + 7 * MIN, 1000), step(T0 + 21 * MIN, 1000)],
    });
    expect(buildSessionRecords(s).records.map((r) => r.context.startKind)).toEqual(['first-prompt', 'clear', 'compact']);
  });
});

describe('edit statistics', () => {
  it('counts repeated Write and edits of freshly written text; MultiEdit lines', () => {
    const s = session({
      prompts: [prompt('do it', T0)],
      calls: [
        step(T0 + 1000, 1000, 100, 100, {
          toolUses: [
            use('a', 'Write', { file_path: '/p/a.ts', content: 'l1\nl2' }),
            use('b', 'Write', { file_path: '/p/a.ts', content: 'l1\nl2\nl3' }),
            use('c', 'Edit', { file_path: '/p/b.ts', old_string: 'alpha beta gamma', new_string: 'delta epsilon zeta' }),
            use('d', 'Edit', { file_path: '/p/b.ts', old_string: 'delta epsilon', new_string: 'eta' }),
            use('e', 'MultiEdit', { file_path: '/p/c.ts', edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: 'q', new_string: 'r' }] }),
          ],
        }),
      ],
    });
    const o = buildSessionRecords(s).records[0]!.observed;
    expect(o.sameEditRepeats).toBe(2);
    expect(o.linesChanged).toBe(2 + 3 + 2 + 2 + 3 + 2);
    expect(o.filesEdited).toBe(3);
  });
});

describe('projectLabel', () => {
  it('falls back to the directory name without the user', () => {
    expect(projectLabel(session({ project: '-Users-bob-Projects-x' }))).toBe('~-Projects-x');
    expect(projectLabel(session({ project: 'plain', cwd: '/srv/app' }))).toBe('/srv/app');
    expect(projectLabel(session({ project: 'p', cwd: '/home/ann/code' }))).toBe('~/code');
  });
});

describe('L0 heuristics', () => {
  const T = L0_THRESHOLDS;

  it('haiku: a question with few calls and no edits or errors', () => {
    expect(l0Label(observed({ mainCalls: 2, filesEdited: 0, linesChanged: 0 }), 'как работает кэш?')).toMatchObject({ tier: 'haiku', effort: 'low' });
    expect(l0Label(observed({ mainCalls: 3, filesEdited: 0, linesChanged: 0 }), 'explain the retry logic')).toMatchObject({ tier: 'haiku' });
  });

  it('haiku needs every condition', () => {
    const q = 'what does this do?';
    const base = { mainCalls: T.haiku.maxMainCalls, filesEdited: 0, linesChanged: 0 };
    expect(l0Label(observed({ ...base, mainCalls: 4 }), q).tier).toBe('sonnet');
    expect(l0Label(observed({ ...base, filesEdited: 1 }), q).tier).toBe('sonnet');
    expect(l0Label(observed({ ...base, toolErrors: 1 }), q).tier).toBe('sonnet');
    expect(l0Label(observed(base), 'refactor the parser').tier).toBe('sonnet'); // not a question
    expect(l0Label(observed(base), 'what? ' + 'x'.repeat(700)).tier).toBe('sonnet'); // too long
  });

  it.each<[string, Partial<TaskObserved>]>([
    ['many calls', { mainCalls: T.opus.minMainCalls }],
    ['many files', { filesEdited: T.opus.minFilesEdited }],
    ['corrections', { userCorrections: T.opus.minCorrections }],
    ['plan mode', { planMode: true }],
    ['test failures', { testFailures: T.opus.minTestFailures }],
  ])('opus on %s', (_n, o) => {
    expect(l0Label(observed(o), 'any')).toMatchObject({ tier: 'opus', effort: 'high' });
  });

  it('opus signals one below the threshold stay sonnet', () => {
    const o = observed({ mainCalls: 39, filesEdited: 7, userCorrections: 1, testFailures: 2, planMode: false });
    expect(l0Label(o, 'fix it').tier).toBe('sonnet');
  });

  it('sonnet effort: low for light clean tasks, high for long or messy ones, else medium', () => {
    expect(l0Label(observed({ mainCalls: 8, filesEdited: 2 }), 'fix it')).toMatchObject({ tier: 'sonnet', effort: 'low' });
    expect(l0Label(observed({ mainCalls: 9, filesEdited: 2 }), 'fix it').effort).toBe('medium');
    expect(l0Label(observed({ mainCalls: 10, filesEdited: 1, toolErrors: 1 }), 'fix it').effort).toBe('medium');
    expect(l0Label(observed({ mainCalls: 20, filesEdited: 1 }), 'fix it').effort).toBe('high');
    expect(l0Label(observed({ mainCalls: 10, filesEdited: 4 }), 'fix it').effort).toBe('high');
    expect(l0Label(observed({ mainCalls: 10, filesEdited: 1, toolErrors: 5 }), 'fix it').effort).toBe('high');
    expect(l0Label(observed({ mainCalls: 10, filesEdited: 1, userCorrections: 1 }), 'fix it').effort).toBe('high');
  });

  it('difficulty is monotone, bounded to 0..1 and saturates at 1', () => {
    const none = difficultyScore(observed({ mainCalls: 0, filesEdited: 0, linesChanged: 0 }));
    const some = difficultyScore(observed({ mainCalls: 10 }));
    const lots = difficultyScore(observed({ mainCalls: 100, filesEdited: 20, linesChanged: 5000, userCorrections: 5, toolErrors: 9, planMode: true, subagentCalls: 30 }));
    expect(none).toBe(0);
    expect(some).toBeGreaterThan(none);
    expect(lots).toBe(1);
    const w = Object.values(T.difficulty).reduce((a, d) => a + d.weight, 0);
    expect(w).toBeCloseTo(1);
  });

  it('isLookupPrompt', () => {
    expect(isLookupPrompt('Где лежит конфиг')).toBe(true);
    expect(isLookupPrompt('is this safe?')).toBe(true);
    expect(isLookupPrompt('Show me the diff')).toBe(true);
    expect(isLookupPrompt('Добавь кнопку')).toBe(false);
    expect(isLookupPrompt('However, do it')).toBe(false); // "how" must be a whole word
  });
});

describe('summary and rendering', () => {
  const mk = (tier: 'haiku' | 'sonnet' | 'opus', observedTier: string, corrections = 0, cost = 1): TaskRecord => ({
    v: 1,
    taskId: Math.random().toString(16).slice(2, 18),
    project: '~/p',
    startTs: T0,
    text: ['x'],
    context: { contextTokensAtStart: 1, startKind: 'first-prompt', languages: [], hasGitBranch: false, prevTaskWasHeavy: false },
    observed: observed({ modelTier: observedTier, userCorrections: corrections, cost }),
    difficulty: 0.2,
    l0Tier: tier,
    l0Effort: 'low',
    rulesVerdict: { tier: 'sonnet', effort: 'high', confidence: 0.4, reasons: [] },
    labelSource: 'L0',
  });
  const records = [mk('haiku', 'opus', 0, 2), mk('sonnet', 'opus', 1, 3), mk('opus', 'opus'), mk('sonnet', 'sonnet'), mk('sonnet', 'unknown')];
  const hits = { 'private-key': 0, 'url-credentials': 0, jwt: 0, 'api-key': 4, bearer: 0, assignment: 2, email: 1, 'home-path': 7, 'high-entropy': 0 };
  const summary = summarize({ records, hits, out: '/x/tasks.jsonl', sessions: 3, since: 'all', durationMs: 1234, now: new Date('2026-10-05T10:00:00Z') });

  it('aggregates', () => {
    expect(summary).toMatchObject({ tasks: 5, sessions: 3, projects: 1, l0Tier: { haiku: 1, sonnet: 3, opus: 1 }, observedTier: { opus: 3, sonnet: 1, unknown: 1 } });
    expect(summary.confusion.opus).toEqual({ haiku: 1, sonnet: 1, opus: 1 });
    expect(summary.overSpec).toEqual({ count: 2, share: 0.4, cost: 5 });
    expect(summary.withCorrections).toEqual({ count: 1, share: 0.2 });
    expect(summary.rulesAgreement).toBeCloseTo(0.6);
    expect(summary.scrub.total).toBe(14);
  });

  it.each(['ru', 'en'] as const)('renders in %s without color', (lang) => {
    const out = renderDatasetSummary(summary, { color: 'none', width: 80, lang });
    expect(out).toContain('◆');
    expect(out).toContain('agento dataset build');
    expect(out).toContain('L0');
    expect(out).toContain('█');
    expect(out).toContain('20%');
    expect(out).toContain('tasks.jsonl');
    for (const l of out.split('\n')) expect([...l].length).toBeLessThanOrEqual(100);
    expect(out).not.toMatch(/\x1b/);
  });

  it('renders colors and the empty case', () => {
    expect(renderDatasetSummary(summary, { color: 'truecolor', width: 80, lang: 'ru' })).toMatch(/\x1b\[/);
    const empty = summarize({ records: [], hits, out: '/x', sessions: 0, since: '30d', durationMs: 5 });
    expect(renderDatasetSummary(empty, { color: 'none', width: 80, lang: 'en' })).toContain('No tasks found');
  });
});

describe('writing', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  const c = corpus([
    session({
      sessionId: 'a',
      prompts: [prompt('first, password=hunter2', T0), prompt('second task', T0 + 60 * MIN)],
      calls: [step(T0 + MIN, 1000), step(T0 + 61 * MIN, 1000)],
    }),
    session({ sessionId: 'b', prompts: [prompt('other', T0 + 5 * MIN)], calls: [step(T0 + 6 * MIN, 1000, 100, 100, { sessionId: 'b' })] }),
  ]);

  it('resolves AGENTO_HOME', () => {
    expect(agentoHome({ AGENTO_HOME: '/h' })).toBe('/h');
    expect(defaultOutPath({ AGENTO_HOME: '/h' })).toBe('/h/dataset/tasks.jsonl');
    expect(agentoHome({})).toMatch(/\.agento$/);
    expect(summaryPathFor('/h/dataset/tasks.jsonl')).toBe('/h/dataset/summary.json');
    expect(summaryPathFor('/o/my.jsonl')).toBe('/o/my.summary.json');
    expect(summaryPathFor('/o/my')).toBe('/o/my.summary.json');
  });

  it('writes tasks.jsonl and summary.json into AGENTO_HOME, atomically and idempotently', () => {
    home = mkdtempSync(join(tmpdir(), 'agento-ds-'));
    const prev = process.env.AGENTO_HOME;
    process.env.AGENTO_HOME = home;
    try {
      const r1 = writeDataset(c, { sinceLabel: 'all', started: Date.now() });
      expect(r1.outPath).toBe(join(home, 'dataset', 'tasks.jsonl'));
      const lines = readFileSync(r1.outPath, 'utf8').trimEnd().split('\n');
      expect(lines).toHaveLength(3);
      const rows = lines.map((l) => JSON.parse(l) as TaskRecord);
      expect(rows.map((r) => r.startTs)).toEqual([...rows.map((r) => r.startTs)].sort((a, b) => a - b));
      expect(new Set(rows.map((r) => r.taskId)).size).toBe(3);
      expect(rows.every((r) => r.labelSource === 'L0' && r.v === 1)).toBe(true);
      expect(readFileSync(r1.outPath, 'utf8')).not.toContain('hunter2');
      const summary = JSON.parse(readFileSync(join(home, 'dataset', 'summary.json'), 'utf8'));
      expect(summary).toMatchObject({ tasks: 3, sessions: 2, scrub: { total: 1 } });
      expect(JSON.stringify(summary)).not.toContain('first');

      writeDataset(c, { sinceLabel: 'all', started: Date.now() }); // overwrite
      expect(readFileSync(r1.outPath, 'utf8').trimEnd().split('\n')).toHaveLength(3);
      expect(readdirSync(join(home, 'dataset')).sort()).toEqual(['summary.json', 'tasks.jsonl']); // no temp files left
    } finally {
      if (prev === undefined) delete process.env.AGENTO_HOME;
      else process.env.AGENTO_HOME = prev;
    }
  });

  it('honours --out', () => {
    home = mkdtempSync(join(tmpdir(), 'agento-ds-'));
    const out = join(home, 'nested', 'x.jsonl');
    const r = writeDataset(c, { out, sinceLabel: '30d', project: 'p', started: Date.now() });
    expect(r.summaryPath).toBe(join(home, 'nested', 'x.summary.json'));
    expect(readFileSync(out, 'utf8').trimEnd().split('\n')).toHaveLength(3);
    expect(r.summary.filters).toEqual({ since: '30d', project: 'p' });
  });

  it('buildRecords is deterministic', () => {
    expect(buildRecords(c).records).toEqual(buildRecords(c).records);
  });
});
