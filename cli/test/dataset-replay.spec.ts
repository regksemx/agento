import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeUsage } from '../../plugin/core/cost.ts';
import { loadCorpus } from '../src/transcripts.ts';
import type { ApiCall, Corpus, SessionData } from '../src/types.ts';
import { buildSessionRecords, taskId } from '../src/dataset/features.ts';
import type { TaskRecord } from '../src/dataset/types.ts';
import { Cleanup } from '../src/dataset/replay/cleanup.ts';
import { allowedTools, claudeRunArgs, composePrompt, parseRunOutput, type RunRequest, type Runner, type RunResult } from '../src/dataset/replay/claude.ts';
import { datasetReplayCmd, parseReplayFlags } from '../src/dataset/replay/command.ts';
import { executeRun, allPass, type RunContext } from '../src/dataset/replay/exec.ts';
import { commitBefore, createWorktree, detectDirtyStart, detectTestCommand, resetWorktree, resolveBranch, runGit, worktreeDiff, type GitFn } from '../src/dataset/replay/git.ts';
import { parseDiffVerdict } from '../src/dataset/replay/judgeDiff.ts';
import { Budget, runLadder } from '../src/dataset/replay/ladder.ts';
import { buildPlan, detectAccount } from '../src/dataset/replay/plan.ts';
import { renderPlan, renderReplaySummary } from '../src/dataset/replay/render.ts';
import { selectTasks } from '../src/dataset/replay/select.ts';
import { buildTaskSources, isNeutralFollowUp, renderOriginalDiff } from '../src/dataset/replay/source.ts';
import { appendJsonl, priorRunMap, readLabels, readRuns, runKey } from '../src/dataset/replay/store.ts';
import { summarizeReplay } from '../src/dataset/replay/summary.ts';
import { DEFAULT_LADDER, FALLBACK_CONFIG, parseLadder, type Candidate, type ReplayConfig, type RunRecord, type TaskSource } from '../src/dataset/replay/types.ts';

// ───────────────────────── helpers ─────────────────────────

const T0 = Date.parse('2026-02-01T12:00:00Z'); // task start
const COMMIT_DATE = '2026-01-30T10:00:00Z';

let tmp: string;
beforeEach(() => void (tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agento-replay-test-')))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) },
  }).trim();
}

function makeRepo(files: Record<string, string> = { 'src.txt': 'hello world\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }, date = COMMIT_DATE): string {
  const dir = join(tmp, 'repo');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init'], date);
  return dir;
}

function call(ts: number, tools: Array<{ name: string; input: Record<string, unknown> }> = [], id = `m${ts}`): ApiCall {
  return {
    messageId: id,
    sessionId: 's1',
    project: 'p',
    lineage: 'main',
    ts,
    model: 'claude-opus-5-5',
    usage: normalizeUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20_000 }),
    effort: 'high',
    isSidechain: false,
    toolUses: tools.map((t, i) => ({ id: `${id}-t${i}`, name: t.name, input: t.input })),
  };
}

interface SessOpts {
  cwd?: string;
  branch?: string;
  prompts?: string[];
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  sessionId?: string;
  fileHistory?: SessionData['fileHistory'];
  priorCalls?: ApiCall[];
}

function session(o: SessOpts = {}): SessionData {
  const prompts = o.prompts ?? ['fix the bug in src.txt'];
  return {
    sessionId: o.sessionId ?? 's1',
    project: '-proj',
    cwd: o.cwd,
    gitBranch: o.branch ?? 'main',
    firstTs: T0,
    lastTs: T0 + 60_000,
    calls: [...(o.priorCalls ?? []), call(T0 + 5_000, o.tools ?? [{ name: 'Edit', input: { file_path: 'src.txt', old_string: 'hello', new_string: 'bye' } }], `m-${o.sessionId ?? 's1'}`)],
    prompts: prompts.map((text, i) => ({ uuid: `u${i}`, sessionId: o.sessionId ?? 's1', project: '-proj', ts: T0 + i * 1000, text, isSlashCommand: false })),
    toolResults: [],
    markers: [],
    agents: {},
    ...(o.fileHistory ? { fileHistory: o.fileHistory } : {}),
  };
}

function corpusOf(...sessions: SessionData[]): Corpus {
  return { dir: tmp, sessions, stats: { files: sessions.length, lines: 0, badLines: 0, duplicateRows: 0, unknownModelCalls: 0, parseMs: 0 } };
}

function tasksAndSources(s: SessionData): { tasks: TaskRecord[]; sources: Map<string, TaskSource> } {
  return { tasks: buildSessionRecords(s).records, sources: buildTaskSources(corpusOf(s)) };
}

const noLabels = new Set<string>();

// ───────────────────────── ladder spec, neutral follow-ups ─────────────────────────

describe('parseLadder', () => {
  it('reads tier-effort pairs in several spellings and keeps the order', () => {
    expect(parseLadder('haiku-low, Sonnet·medium,sonnet high').map((c) => c.id)).toEqual(['haiku-low', 'sonnet-medium', 'sonnet-high']);
  });
  it('rejects unknown tiers, efforts and duplicates', () => {
    expect(() => parseLadder('gpt-low')).toThrow(/--ladder/);
    expect(() => parseLadder('haiku-max')).toThrow(/--ladder/);
    expect(() => parseLadder('haiku-low,haiku-low')).toThrow(/twice/);
    expect(() => parseLadder(' , ')).toThrow(/no configurations/);
  });
  it('the default ladder is haiku·low -> sonnet·medium -> sonnet·high -> opus·medium', () => {
    expect(DEFAULT_LADDER.map((c) => c.id)).toEqual(['haiku-low', 'sonnet-medium', 'sonnet-high', 'opus-medium']);
  });
});

describe('isNeutralFollowUp', () => {
  it.each(['да', 'Ок.', 'продолжай', 'yes', 'go on', 'yes please', 'ok, давай', 'continue!'])('accepts %s', (t) => expect(isNeutralFollowUp(t)).toBe(true));
  it.each(['нет', 'не так, переделай', 'yes but also add tests', 'add a button', '', 'да да да да да'])('rejects %s', (t) => expect(isNeutralFollowUp(t)).toBe(false));
});

// ───────────────────────── transcripts: file-history rows ─────────────────────────

describe('file-history rows in transcripts', () => {
  it('parses snapshots (tracked files with backup times) and deltas, as a pure addition', async () => {
    const dir = join(tmp, 'projects', '-proj');
    mkdirSync(dir, { recursive: true });
    const rows = [
      { type: 'file-history-snapshot', messageId: 'a', snapshot: { messageId: 'a', trackedFileBackups: {}, timestamp: '2026-02-01T10:00:00.000Z' }, isSnapshotUpdate: false },
      {
        type: 'file-history-snapshot',
        messageId: 'b',
        snapshot: { messageId: 'b', trackedFileBackups: { 'src/a.ts': { backupFileName: 'x@v2', version: 2, backupTime: '2026-02-01T10:05:00.000Z' } }, timestamp: '2026-02-01T10:06:00.000Z' },
        isSnapshotUpdate: false,
      },
      { type: 'file-history-delta', messageId: 'c', snapshotMessageId: 'a', trackingPath: '/r/src/b.ts', backup: { backupFileName: null, version: 1, backupTime: '2026-02-01T10:07:00.000Z' }, timestamp: '2026-02-01T10:07:00.100Z' },
      { type: 'user', uuid: 'u1', timestamp: '2026-02-01T10:00:01.000Z', cwd: '/r', gitBranch: 'main', message: { role: 'user', content: 'hello there' } },
    ];
    writeFileSync(join(dir, 'sess.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const c = await loadCorpus({ dir: join(tmp, 'projects') });
    const h = c.sessions[0]!.fileHistory!;
    expect(h).toHaveLength(2); // the empty snapshot is dropped
    expect(h[0]).toMatchObject({ kind: 'snapshot', files: [{ path: 'src/a.ts', ts: Date.parse('2026-02-01T10:05:00.000Z') }] });
    expect(h[1]).toMatchObject({ kind: 'delta', files: [{ path: '/r/src/b.ts', ts: Date.parse('2026-02-01T10:07:00.000Z') }] });
    expect(c.sessions[0]!.cwd).toBe('/r');
  });

  it('leaves fileHistory absent when the transcript has none', async () => {
    const dir = join(tmp, 'projects', '-proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.jsonl'), JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-02-01T10:00:01.000Z', message: { role: 'user', content: 'hi' } }) + '\n');
    expect((await loadCorpus({ dir: join(tmp, 'projects') })).sessions[0]!.fileHistory).toBeUndefined();
  });
});

// ───────────────────────── git: commit resolution, dirty start, verification command ─────────────────────────

describe('commit resolution (temp repo)', () => {
  it('picks the latest commit with commit time <= the task start, on the task branch', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src.txt'), 'second\n');
    git(repo, ['commit', '-qam', 'second'], '2026-01-31T10:00:00Z');
    writeFileSync(join(repo, 'src.txt'), 'third\n');
    git(repo, ['commit', '-qam', 'third'], '2026-02-03T10:00:00Z'); // after the task
    const ref = resolveBranch(repo, 'main')!;
    expect(ref).toBe('refs/heads/main');
    const c = commitBefore(repo, ref, T0)!;
    expect(git(repo, ['show', '-s', '--format=%s', c.sha])).toBe('second');
    expect(c.ts).toBe(Date.parse('2026-01-31T10:00:00Z'));
    expect(commitBefore(repo, ref, Date.parse('2026-01-01T00:00:00Z'))).toBeUndefined();
  });

  it('does not see commits of another branch, and a missing branch resolves to undefined', () => {
    const repo = makeRepo();
    git(repo, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repo, 'src.txt'), 'feature work\n');
    git(repo, ['commit', '-qam', 'feature'], '2026-01-31T10:00:00Z');
    expect(git(repo, ['show', '-s', '--format=%s', commitBefore(repo, 'refs/heads/main', T0)!.sha])).toBe('init');
    expect(resolveBranch(repo, 'gone')).toBeUndefined();
  });
});

describe('detectTestCommand', () => {
  const cases: Array<[string, Record<string, string>, string | undefined]> = [
    ['npm script', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, 'npm test'],
    ['pnpm by lockfile', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'pnpm-lock.yaml': '' }, 'pnpm test'],
    ['npm placeholder script is not a test', { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }, undefined],
    ['go', { 'go.mod': 'module x\n' }, 'go test ./...'],
    ['cargo', { 'Cargo.toml': '[package]\n' }, 'cargo test'],
    ['pytest.ini', { 'pytest.ini': '[pytest]\n' }, 'python3 -m pytest -x -q'],
    ['pytest in pyproject', { 'pyproject.toml': '[tool.pytest.ini_options]\n' }, 'python3 -m pytest -x -q'],
    ['gradle wrapper', { gradlew: '#!/bin/sh\n' }, './gradlew test'],
    ['maven', { 'pom.xml': '<project/>' }, 'mvn -q test'],
    ['nothing', { 'README.md': 'x' }, undefined],
  ];
  it.each(cases)('%s', (_name, files, want) => {
    const repo = makeRepo(files);
    const c = commitBefore(repo, 'refs/heads/main', T0)!;
    expect(detectTestCommand(repo, c.sha)?.command).toBe(want);
  });
});

describe('detectDirtyStart', () => {
  const srcOf = (over: Partial<TaskSource>): TaskSource => ({
    taskId: 't',
    sessionId: 's',
    projectDir: 'p',
    startTs: T0,
    windowEnd: Infinity,
    prompts: [],
    edits: [],
    editToolUseIds: [],
    priorTouched: [],
    repricedUsd: { haiku: 0, sonnet: 0, opus: 0 },
    ...over,
  });

  it('clean: the first edit matches the commit and earlier edits were committed afterwards', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src.txt'), 'hello world\nmore\n');
    git(repo, ['commit', '-qam', 'more'], '2026-01-31T10:00:00Z');
    const sha = commitBefore(repo, 'refs/heads/main', T0)!.sha;
    const r = detectDirtyStart(repo, repo, sha, srcOf({ priorTouched: [{ path: join(repo, 'src.txt'), ts: Date.parse('2026-01-31T09:00:00Z') }], edits: [{ ts: T0, tool: 'Edit', path: 'src.txt', oldString: 'hello' }] }));
    expect(r).toEqual({ dirty: false, reasons: [] });
  });

  it('dirty: an edit made earlier in the session was never committed (snapshot/prior-edit signal)', () => {
    const repo = makeRepo();
    const sha = commitBefore(repo, 'refs/heads/main', T0)!.sha;
    const r = detectDirtyStart(repo, repo, sha, srcOf({ priorTouched: [{ path: 'src.txt', ts: Date.parse('2026-02-01T09:00:00Z') }] }));
    expect(r.dirty).toBe(true);
    expect(r.reasons).toEqual(['uncommitted-edit']);
  });

  it('dirty: a new file the session created before the task is not in the commit', () => {
    const repo = makeRepo();
    const sha = commitBefore(repo, 'refs/heads/main', T0)!.sha;
    const r = detectDirtyStart(repo, repo, sha, srcOf({ priorTouched: [{ path: join(repo, 'new.ts'), ts: Date.parse('2026-02-01T09:00:00Z') }] }));
    expect(r.reasons).toEqual(['uncommitted-new-file']);
  });

  it('gitignored files the session touched do not count', () => {
    const repo = makeRepo({ 'src.txt': 'x\n', '.gitignore': 'out/\n' });
    const sha = commitBefore(repo, 'refs/heads/main', T0)!.sha;
    const r = detectDirtyStart(repo, repo, sha, srcOf({ priorTouched: [{ path: join(repo, 'out', 'a.js'), ts: Date.parse('2026-02-01T09:00:00Z') }] }));
    expect(r.dirty).toBe(false);
  });

  it('dirty: the first edit of the task expects text that is not in the commit', () => {
    const repo = makeRepo();
    const sha = commitBefore(repo, 'refs/heads/main', T0)!.sha;
    expect(detectDirtyStart(repo, repo, sha, srcOf({ edits: [{ ts: T0, tool: 'Edit', path: 'src.txt', oldString: 'text that is nowhere' }] })).reasons).toEqual(['old-string-mismatch']);
    expect(detectDirtyStart(repo, repo, sha, srcOf({ edits: [{ ts: T0, tool: 'Edit', path: 'missing.txt', oldString: 'x' }] })).reasons).toEqual(['edited-file-missing']);
    expect(detectDirtyStart(repo, repo, sha, srcOf({ edits: [{ ts: T0, tool: 'Write', path: 'brand-new.txt' }] })).dirty).toBe(false);
  });
});

// ───────────────────────── worktrees ─────────────────────────

describe('worktree create and cleanup (temp repo)', () => {
  it('creates a detached worktree at the commit, never touches the working tree, and removes everything', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src.txt'), 'uncommitted user work\n'); // the user's dirty tree
    const sha = commitBefore(repo, 'refs/heads/main', T0)!.sha;
    const base = join(tmp, 'wt');
    mkdirSync(base);
    const wt = createWorktree(repo, base, 'task1', sha);
    expect(readFileSync(join(wt.path, 'src.txt'), 'utf8')).toBe('hello world\n'); // the commit, not the dirty file
    expect(git(repo, ['worktree', 'list'])).toContain('task1');
    expect(git(wt.path, ['rev-parse', 'HEAD'])).toBe(sha);

    writeFileSync(join(wt.path, 'src.txt'), 'agent edit\n');
    writeFileSync(join(wt.path, 'added.txt'), 'new\n');
    const d = worktreeDiff(wt);
    expect(d.files).toBe(2);
    expect(d.patch).toContain('agent edit');
    resetWorktree(wt);
    expect(readFileSync(join(wt.path, 'src.txt'), 'utf8')).toBe('hello world\n');
    expect(existsSync(join(wt.path, 'added.txt'))).toBe(false);
    expect(worktreeDiff(wt).files).toBe(0);

    wt.remove();
    wt.remove(); // idempotent
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, ['worktree', 'list'])).not.toContain('task1');
    expect(readFileSync(join(repo, 'src.txt'), 'utf8')).toBe('uncommitted user work\n'); // untouched
    expect(git(repo, ['status', '--porcelain'])).toBe('M src.txt');
  });

  it('Cleanup removes registered worktrees on runAll (the crash path) and tolerates throwing handlers', () => {
    const repo = makeRepo();
    const sha = commitBefore(repo, 'refs/heads/main', T0)!.sha;
    const wt = createWorktree(repo, tmp, 'crashy', sha);
    const c = new Cleanup();
    c.add(() => {
      throw new Error('boom');
    });
    c.add(() => wt.remove());
    c.runAll();
    expect(existsSync(wt.path)).toBe(false);
    expect(c.size).toBe(0);
    c.runAll(); // second call is a no-op
  });

  it('throws a clear error when git refuses', () => {
    const repo = makeRepo();
    expect(() => createWorktree(repo, tmp, 'x', '0'.repeat(40))).toThrow(/worktree add failed/);
  });
});

// ───────────────────────── selection ─────────────────────────

describe('selectTasks', () => {
  const ladder: ReplayConfig[] = [...DEFAULT_LADDER];
  const run = (s: SessionData, extra: Partial<Parameters<typeof selectTasks>[0]> = {}): ReturnType<typeof selectTasks> => {
    const { tasks, sources } = tasksAndSources(s);
    return selectTasks({ tasks, sources, labeled: noLabels, ladder, ...extra });
  };
  const reasonOf = (r: ReturnType<typeof selectTasks>): string | undefined => r.skipped[0]?.reason;

  it('selects a single-prompt task in a repo, with commit, test command and priority data', () => {
    const repo = makeRepo();
    const r = run(session({ cwd: repo }));
    expect(r.skipped).toEqual([]);
    const c = r.candidates[0]!;
    expect(c).toMatchObject({ repoRoot: repo, relCwd: '', branch: 'main', dirtyStart: false, originalEdited: true });
    expect(c.testCommand?.command).toBe('npm test');
    expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(c.estUsd)).toEqual(ladder.map((l) => l.id));
    expect(c.estUsd['opus-medium']!).toBeGreaterThanOrEqual(c.estUsd['haiku-low']!); // both floored at the minimum for a tiny synthetic task
  });

  it('accepts neutral follow-ups and rejects a real second instruction', () => {
    const repo = makeRepo();
    expect(run(session({ cwd: repo, prompts: ['do it', 'да', 'продолжай'] })).candidates).toHaveLength(1);
    expect(reasonOf(run(session({ cwd: repo, prompts: ['do it', 'now also refactor the parser'] })))).toBe('multi-prompt');
  });

  it('skips with a reason: no cwd, missing dir, not a repo, no branch, missing branch, no commit, stale commit', () => {
    const repo = makeRepo();
    expect(reasonOf(run(session({})))).toBe('no-cwd');
    expect(reasonOf(run(session({ cwd: join(tmp, 'nope') })))).toBe('cwd-missing');
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    expect(reasonOf(run(session({ cwd: plain })))).toBe('not-a-repo');
    const s = session({ cwd: repo });
    delete (s as { gitBranch?: string }).gitBranch;
    expect(reasonOf(run(s))).toBe('no-branch');
    expect(reasonOf(run(session({ cwd: repo, branch: 'HEAD' })))).toBe('no-branch');
    expect(reasonOf(run(session({ cwd: repo, branch: 'deleted-branch' })))).toBe('branch-missing');
    const late = join(tmp, 'late');
    mkdirSync(late);
    git(late, ['init', '-q', '-b', 'main']);
    writeFileSync(join(late, 'a'), 'a');
    git(late, ['add', '-A']);
    git(late, ['commit', '-qm', 'x'], '2026-03-01T00:00:00Z'); // after the task
    expect(reasonOf(run(session({ cwd: late })))).toBe('no-commit');
    expect(reasonOf(run(session({ cwd: repo }), { maxCommitAgeMs: 3600_000 }))).toBe('stale-commit');
  });

  it('skips dirty starts by default and keeps them (marked) with includeDirty', () => {
    const repo = makeRepo();
    const s = session({ cwd: repo, fileHistory: [{ ts: T0 - 3600_000, kind: 'snapshot', files: [{ path: 'src.txt', ts: T0 - 3600_000 }] }] });
    const r = run(s);
    expect(r.candidates).toHaveLength(0);
    expect(reasonOf(r)).toBe('dirty-start');
    expect(r.dirty).toBe(1);
    const kept = run(s, { includeDirty: true });
    expect(kept.candidates[0]).toMatchObject({ dirtyStart: true, dirtyReasons: ['uncommitted-edit'] });
  });

  it('skips a task that edited nothing, with or without a test command (a no-op replay passes every check)', () => {
    const noTests = makeRepo({ 'README.md': 'x\n' });
    const read = [{ name: 'Read', input: { file_path: 'README.md' } }];
    expect(reasonOf(run(session({ cwd: noTests, tools: read })))).toBe('no-verification');
    rmSync(noTests, { recursive: true, force: true });
    const withTests = makeRepo();
    expect(reasonOf(run(session({ cwd: withTests, tools: [{ name: 'Read', input: { file_path: 'src.txt' } }] })))).toBe('no-verification');
  });

  it('skips tasks that already have a label, and tasks that are not in the transcripts', () => {
    const repo = makeRepo();
    const { tasks, sources } = tasksAndSources(session({ cwd: repo }));
    expect(selectTasks({ tasks, sources, labeled: new Set([tasks[0]!.taskId]), ladder }).skipped[0]?.reason).toBe('already-labeled');
    expect(selectTasks({ tasks, sources: new Map(), labeled: noLabels, ladder }).skipped[0]?.reason).toBe('no-source');
  });

  it('orders candidates: test command first, then L1 disagreement, then by taskId; counts reasons', () => {
    const withTests = makeRepo();
    const noTests = join(tmp, 'notests');
    mkdirSync(noTests);
    git(noTests, ['init', '-q', '-b', 'main']);
    writeFileSync(join(noTests, 'src.txt'), 'hello world\n');
    git(noTests, ['add', '-A']);
    git(noTests, ['commit', '-qm', 'x'], COMMIT_DATE);
    const a = session({ cwd: noTests, sessionId: 'a' });
    const b = session({ cwd: withTests, sessionId: 'b' });
    const c = session({ cwd: withTests, sessionId: 'c', prompts: ['x', 'and then something else'] });
    const sources = buildTaskSources(corpusOf(a, b, c));
    const tasks = [a, b, c].flatMap((s) => buildSessionRecords(s).records);
    const idOf = (sid: string): string => taskId(sid, T0);
    const r = selectTasks({ tasks, sources, labeled: noLabels, ladder, l1Cheaper: new Set([idOf('a')]) });
    expect(r.candidates.map((x) => x.taskId)).toEqual([idOf('b'), idOf('a')]); // b has tests; a is the L1 disagreement but has none
    expect(r.skippedByReason).toEqual({ 'multi-prompt': 1 });
  });
});

describe('buildTaskSources', () => {
  it('collects raw prompts, edits, prior touched files and repriced cost', () => {
    const prior = call(T0 - 3600_000, [{ name: 'Write', input: { file_path: '/r/old.ts', content: 'x' } }], 'prior');
    const s = session({ cwd: '/r', priorCalls: [prior], fileHistory: [{ ts: T0 - 1000, kind: 'delta', files: [{ path: 'b.ts', ts: T0 - 2000 }] }] });
    // a call before the first prompt is outside the task window; keep only the prompt-anchored one
    const src = [...buildTaskSources(corpusOf(s)).values()][0]!;
    expect(src.prompts.map((p) => p.text)).toEqual(['fix the bug in src.txt']);
    expect(src.edits[0]).toMatchObject({ tool: 'Edit', path: 'src.txt', oldString: 'hello' });
    expect(src.priorTouched.map((p) => p.path).sort()).toEqual(['/r/old.ts', 'b.ts']);
    expect(src.repricedUsd.opus).toBeGreaterThan(src.repricedUsd.sonnet);
    expect(src.repricedUsd.sonnet).toBeGreaterThan(src.repricedUsd.haiku);
  });
});

describe('renderOriginalDiff', () => {
  it('shows Edit as -/+ and Write as +, relative to the repo root, and cuts at the limit', () => {
    const text = renderOriginalDiff(
      [
        { tool: 'Edit', input: { file_path: '/r/a.ts', old_string: 'one\ntwo', new_string: 'three' } },
        { tool: 'Write', input: { file_path: '/r/b.ts', content: 'x\ny' } },
      ],
      '/r',
    );
    expect(text).toContain('--- a.ts\n-one\n-two\n+three');
    expect(text).toContain('--- b.ts (written)\n+x\n+y');
    expect(renderOriginalDiff([{ tool: 'Write', input: { file_path: 'c', content: 'z'.repeat(100) } }], undefined, 40)).toContain('[... cut]');
  });
});

// ───────────────────────── ladder (mocked execute) ─────────────────────────

function rec(config: string, sample: number, pass: boolean, over: Partial<RunRecord> = {}): RunRecord {
  const [tier, effort] = config.split('-') as [ReplayConfig['tier'], ReplayConfig['effort']];
  return {
    v: 1,
    taskId: 't1',
    ts: 1,
    config,
    tier,
    effort,
    sample,
    status: 'ok',
    checks: { tests: 'skipped', diff: pass ? 'pass' : 'fail', judge: 'skipped' },
    pass,
    costUsd: 0.1,
    numTurns: 3,
    durationMs: 1000,
    ...over,
  };
}

const evidence = { originalEdited: true, judge: false, commit: 'c'.repeat(40) };

// verdicts: config id -> pass/fail per sample (default: last value repeats)
function scripted(verdicts: Record<string, boolean[]>, calls: string[] = []): (c: ReplayConfig, s: number, cap: number) => Promise<RunRecord> {
  return async (c, s) => {
    calls.push(`${c.id}#${s}`);
    const seq = verdicts[c.id] ?? [false];
    return rec(c.id, s, seq[Math.min(s - 1, seq.length - 1)]!);
  };
}

describe('runLadder', () => {
  const input = (execute: ReturnType<typeof scripted>, over: Partial<Parameters<typeof runLadder>[0]> = {}): Parameters<typeof runLadder>[0] => ({
    taskId: 't1',
    ladder: DEFAULT_LADDER,
    samples: 2,
    budget: new Budget(100),
    estimate: () => 0.2,
    execute,
    evidence,
    ...over,
  });

  it('stops at the first configuration where all samples pass and labels it', async () => {
    const calls: string[] = [];
    const out = await runLadder(input(scripted({ 'haiku-low': [false], 'sonnet-medium': [true, true] }, calls)));
    expect(out.kind).toBe('labeled');
    if (out.kind !== 'labeled') return;
    expect(calls).toEqual(['haiku-low#1', 'sonnet-medium#1', 'sonnet-medium#2']); // haiku failed sample 1: sample 2 not spent
    expect(out.label).toMatchObject({ l2Tier: 'sonnet', l2Effort: 'medium' });
    expect(out.label.l2Evidence.passedConfig).toBe('sonnet-medium');
    expect(out.label.l2Evidence.steps).toEqual([
      { config: 'haiku-low', samples: 1, passed: 0, pass: false },
      { config: 'sonnet-medium', samples: 2, passed: 2, pass: true },
    ]);
    expect(out.runs).toHaveLength(3);
  });

  it('a configuration passes only if every sample passes (2 samples, one failure = not passed)', async () => {
    const out = await runLadder(input(scripted({ 'haiku-low': [true, false], 'sonnet-medium': [true, true] })));
    if (out.kind !== 'labeled') throw new Error('expected a label');
    expect(out.label.l2Tier).toBe('sonnet');
    expect(out.label.l2Evidence.steps[0]).toEqual({ config: 'haiku-low', samples: 2, passed: 1, pass: false });
  });

  it('labels the first rung when it passes', async () => {
    const out = await runLadder(input(scripted({ 'haiku-low': [true] }), { samples: 3 }));
    if (out.kind !== 'labeled') throw new Error('x');
    expect(out.label).toMatchObject({ l2Tier: 'haiku', l2Effort: 'low' });
    expect(out.runs).toHaveLength(3);
  });

  it('falls back to opus-medium when nothing passes (passedConfig null)', async () => {
    const out = await runLadder(input(scripted({})));
    if (out.kind !== 'labeled') throw new Error('x');
    expect(out.label).toMatchObject({ l2Tier: FALLBACK_CONFIG.tier, l2Effort: FALLBACK_CONFIG.effort });
    expect(out.label.l2Evidence.passedConfig).toBeNull();
    expect(out.label.l2Evidence.steps).toHaveLength(4);
  });

  it('works with a custom ladder and a single sample', async () => {
    const ladder = parseLadder('sonnet-low,opus-high');
    const out = await runLadder(input(scripted({ 'opus-high': [true] }), { ladder, samples: 1 }));
    if (out.kind !== 'labeled') throw new Error('x');
    expect(out.label).toMatchObject({ l2Tier: 'opus', l2Effort: 'high' });
  });

  it('stops before a run whose estimate does not fit the remaining budget and writes no label', async () => {
    const calls: string[] = [];
    const budget = new Budget(0.35);
    const out = await runLadder(input(scripted({}, calls), { budget, estimate: () => 0.2 }));
    expect(out.kind).toBe('stopped');
    if (out.kind === 'stopped') expect(out.reason).toBe('budget');
    expect(calls).toEqual(['haiku-low#1', 'sonnet-medium#1']); // 0.35 -> 0.25 -> 0.15: sonnet-high (est 0.2) never starts
  });

  it('never starts a run that would exceed the budget: remaining shrinks with real costs', async () => {
    const calls: string[] = [];
    const budget = new Budget(0.25);
    const out = await runLadder(input(scripted({}, calls), { budget, estimate: () => 0.2 }));
    expect(out.kind).toBe('stopped');
    expect(calls).toEqual(['haiku-low#1']); // 0.25 - 0.1 = 0.15 < 0.2 for the next rung
    expect(budget.spent).toBeCloseTo(0.1);
  });

  it('hands the executor a cap that is never above the remaining budget', async () => {
    const caps: number[] = [];
    await runLadder(
      input(
        async (c, s, cap) => {
          caps.push(cap);
          return rec(c.id, s, true);
        },
        { budget: new Budget(0.3), estimate: () => 0.2, samples: 1 },
      ),
    );
    expect(caps[0]!).toBeLessThanOrEqual(0.3);
  });

  it('the daily run cap stops the ladder like the budget does', async () => {
    const out = await runLadder(input(scripted({}), { budget: new Budget(100, 1) }));
    expect(out.kind).toBe('stopped');
    if (out.kind === 'stopped') expect(out.reason).toBe('daily-cap');
  });

  it('an infrastructure error gives no verdict (never a fallback label)', async () => {
    const out = await runLadder(input(async (c, s) => rec(c.id, s, false, { status: 'error', error: 'auth' })));
    expect(out.kind).toBe('inconclusive');
    if (out.kind === 'inconclusive') expect(out.reason).toBe('auth');
  });

  it('a timeout is a failed sample, not an infrastructure error', async () => {
    const out = await runLadder(input(async (c, s) => rec(c.id, s, c.id === 'sonnet-medium', { status: c.id === 'haiku-low' ? 'timeout' : 'ok' })));
    if (out.kind !== 'labeled') throw new Error('x');
    expect(out.label.l2Tier).toBe('sonnet');
  });

  it('resumes: finished runs of an earlier invocation are reused, not paid again', async () => {
    const calls: string[] = [];
    const prior = priorRunMap([rec('haiku-low', 1, false), rec('sonnet-medium', 1, true), rec('sonnet-medium', 2, true, { status: 'error' })]);
    const out = await runLadder(input(scripted({ 'sonnet-medium': [true] }, calls), { prior, priorCostUsd: 0.2 }));
    if (out.kind !== 'labeled') throw new Error('x');
    expect(calls).toEqual(['sonnet-medium#2']); // error runs are not reused; the finished ones are
    expect(out.label.l2Evidence.steps[0]).toMatchObject({ config: 'haiku-low', reused: true, pass: false });
    expect(out.label.costUsd).toBeCloseTo(0.3);
  });

  it('persists every run through onRun as soon as it exists', async () => {
    const seen: string[] = [];
    await runLadder(input(scripted({ 'haiku-low': [true] }), { onRun: (r) => seen.push(`${r.config}#${r.sample}`) }));
    expect(seen).toEqual(['haiku-low#1', 'haiku-low#2']);
  });
});

describe('Budget', () => {
  it('tracks spend and run counts', () => {
    const b = new Budget(1, 2);
    expect(b.check(0.5)).toBe('ok');
    b.record(0.6);
    expect(b.check(0.5)).toBe('budget');
    expect(b.check(0.3)).toBe('ok');
    b.record(0.1);
    expect(b.check(0.1)).toBe('daily-cap');
    expect(b.runs).toBe(2);
  });
});

// ───────────────────────── verification (mocked commands) ─────────────────────────

describe('executeRun', () => {
  const cfg: ReplayConfig = { id: 'haiku-low', tier: 'haiku', effort: 'low' };
  const okResult: RunResult = { kind: 'result', isError: false, costUsd: 0.12, numTurns: 4, durationMs: 900 };
  function ctx(over: Partial<RunContext> = {}, log: { requests: RunRequest[]; shells: string[]; resets: number; judged: number } = { requests: [], shells: [], resets: 0, judged: 0 }): { c: RunContext; log: typeof log } {
    const c: RunContext = {
      taskId: 't1',
      prompts: ['secret prompt text'],
      runDir: '/wt',
      testDir: '/wt',
      testCommand: 'npm test',
      testBaseline: 'pass',
      originalEdited: true,
      bash: 'safe',
      runTimeoutMs: 1000,
      testTimeoutMs: 1000,
      runner: async (r) => {
        log.requests.push(r);
        return okResult;
      },
      shell: async (cmd) => {
        log.shells.push(cmd);
        return { code: 0, timedOut: false };
      },
      diff: () => ({ files: 2, lines: 10, patch: 'diff --git' }),
      reset: () => void log.resets++,
      now: () => 42,
      ...over,
    };
    return { c, log };
  }

  it('passes only if the test command and the diff check both pass; records cost, turns, duration, and resets the worktree', async () => {
    const { c, log } = ctx();
    const r = await executeRun(c, cfg, 1, 1);
    expect(r).toMatchObject({ taskId: 't1', config: 'haiku-low', sample: 1, status: 'ok', pass: true, costUsd: 0.12, numTurns: 4, durationMs: 900, diffFiles: 2, diffLines: 10, ts: 42 });
    expect(r.checks).toEqual({ tests: 'pass', diff: 'pass', judge: 'skipped' });
    expect(log.shells).toEqual(['npm test']);
    expect(log.resets).toBe(1);
    expect(log.requests[0]).toMatchObject({ tier: 'haiku', effort: 'low', cwd: '/wt', prompt: 'secret prompt text' });
  });

  it('fails when tests fail', async () => {
    const { c } = ctx({ shell: async () => ({ code: 1, timedOut: false }) });
    const r = await executeRun(c, cfg, 1, 1);
    expect(r.checks.tests).toBe('fail');
    expect(r.pass).toBe(false);
  });

  it('fails on an empty diff when the original edited files, and then does not spend a test run', async () => {
    const { c, log } = ctx({ diff: () => ({ files: 0, lines: 0, patch: '' }) });
    const r = await executeRun(c, cfg, 1, 1);
    expect(r.checks).toEqual({ tests: 'skipped', diff: 'fail', judge: 'skipped' });
    expect(r.pass).toBe(false);
    expect(log.shells).toEqual([]);
  });

  it('an empty diff is fine for a task that edited nothing (the test command decides)', async () => {
    const { c } = ctx({ originalEdited: false, diff: () => ({ files: 0, lines: 0, patch: '' }) });
    const r = await executeRun(c, cfg, 1, 1);
    expect(r.checks.diff).toBe('skipped');
    expect(r.pass).toBe(true);
  });

  it('tests that were already red on the starting commit are unavailable, not a verdict', async () => {
    const { c, log } = ctx({ testBaseline: 'fail' });
    const r = await executeRun(c, cfg, 1, 1);
    expect(r.checks.tests).toBe('unavailable');
    expect(r.pass).toBe(true); // the diff check still passed and is the only evaluated one
    expect(log.shells).toEqual([]);
  });

  it('no evaluated check at all is not a pass', () => {
    expect(allPass({ tests: 'unavailable', diff: 'skipped', judge: 'skipped' })).toBe(false);
    expect(allPass({ tests: 'pass', diff: 'pass', judge: 'skipped' })).toBe(true);
    expect(allPass({ tests: 'pass', diff: 'pass', judge: 'error' })).toBe(false);
  });

  it('judge-diff runs last and only when the cheaper checks passed; its verdict and cost are recorded', async () => {
    let judged = 0;
    const judge = { task: 'task text', originalDiff: '--- a\n+x', fn: async () => (judged++, { pass: true, costUsd: 0.03 }) };
    const { c } = ctx({ judge });
    const r = await executeRun(c, cfg, 1, 1);
    expect(r.checks.judge).toBe('pass');
    expect(r.judgeCostUsd).toBe(0.03);
    expect(r.pass).toBe(true);

    const bad = ctx({ judge: { ...judge, fn: async () => ({ pass: false, costUsd: 0.03 }) } }).c;
    expect((await executeRun(bad, cfg, 1, 1)).pass).toBe(false);

    const failedTests = ctx({ judge, shell: async () => ({ code: 1, timedOut: false }) }).c;
    judged = 0;
    await executeRun(failedTests, cfg, 1, 1);
    expect(judged).toBe(0);

    const errored = ctx({ judge: { ...judge, fn: async () => 'error' } }).c;
    const e = await executeRun(errored, cfg, 1, 1);
    expect(e.checks.judge).toBe('error');
    expect(e.pass).toBe(false);
  });

  it('an agent error (turn/budget cap) fails the run without verification; infrastructure errors are status error', async () => {
    const capped = ctx({ runner: async () => ({ ...okResult, isError: true, subtype: 'error_max_budget_usd' }) });
    const r = await executeRun(capped.c, cfg, 1, 1);
    expect(r).toMatchObject({ status: 'ok', pass: false, agentError: 'error_max_budget_usd' });
    expect(capped.log.shells).toEqual([]);
    expect(capped.log.resets).toBe(1);

    const infra = await executeRun(ctx({ runner: async () => ({ kind: 'error', isError: true, costUsd: 0, numTurns: 0, durationMs: 5, error: 'spawn ENOENT' }) }).c, cfg, 1, 1);
    expect(infra).toMatchObject({ status: 'error', pass: false, error: 'spawn ENOENT' });
    const slow = await executeRun(ctx({ runner: async () => ({ kind: 'timeout', isError: true, costUsd: 0, numTurns: 0, durationMs: 1000, error: 'timeout' }) }).c, cfg, 1, 1);
    expect(slow.status).toBe('timeout');
  });

  it('resets the worktree even when the runner throws', async () => {
    const { c, log } = ctx({ runner: async () => Promise.reject(new Error('kaboom')) });
    await expect(executeRun(c, cfg, 1, 1)).rejects.toThrow('kaboom');
    expect(log.resets).toBe(1);
  });

  it('stores no prompt text in the run record', async () => {
    const r = await executeRun(ctx().c, cfg, 1, 1);
    expect(JSON.stringify(r)).not.toContain('secret prompt text');
  });
});

// ───────────────────────── claude invocation ─────────────────────────

describe('claude invocation', () => {
  const req: RunRequest = { tier: 'sonnet', effort: 'medium', prompt: 'P', cwd: '/wt', maxBudgetUsd: 1.234, timeoutMs: 1, bash: 'safe', testCommand: 'npm test' };
  it('uses the documented flags; --max-turns only on request; the prompt is never an argument', () => {
    const a = claudeRunArgs(req);
    expect(a).toEqual(expect.arrayContaining(['-p', '--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'acceptEdits', '--output-format', 'json', '--no-session-persistence', '--max-budget-usd', '1.23']));
    expect(a).not.toContain('--max-turns');
    expect(a).not.toContain('P');
    expect(claudeRunArgs({ ...req, maxTurns: 30 }).slice(-2)).toEqual(['--max-turns', '30']);
  });
  it('bash modes: safe = test command + read-only, all = Bash, none = no Bash', () => {
    expect(allowedTools('safe', 'npm test')).toContain('Bash(npm test:*)');
    expect(allowedTools('safe', 'npm test')).not.toMatch(/(^|,)Bash(,|$)/);
    expect(allowedTools('all')).toMatch(/(^|,)Bash(,|$)/);
    expect(allowedTools('none')).not.toContain('Bash');
  });
  it('parses the JSON result: cost, turns, duration, is_error', () => {
    expect(parseRunOutput(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.5, num_turns: 7, duration_ms: 1234, result: 'done' }), 1)).toEqual({ kind: 'result', isError: false, subtype: undefined, costUsd: 0.5, numTurns: 7, durationMs: 1234 });
    expect(parseRunOutput(JSON.stringify({ is_error: true, subtype: 'error_max_turns', total_cost_usd: 0.9, num_turns: 30 }), 1)).toMatchObject({ kind: 'result', isError: true, subtype: 'error_max_turns' });
    expect(parseRunOutput('not json', 5)).toMatchObject({ kind: 'error' });
    // an error that never started (auth, credit): infrastructure, not a verdict
    expect(parseRunOutput(JSON.stringify({ is_error: true, total_cost_usd: 0, num_turns: 1, result: 'Credit balance is too low' }), 1)).toMatchObject({ kind: 'error', error: expect.stringContaining('Credit') });
  });
  it('appends bare confirmations to the prompt once', () => {
    expect(composePrompt(['do it'])).toBe('do it');
    expect(composePrompt(['do it', 'да', 'ok'])).toContain('"да", "ok"');
  });
  it('parses the diff judge answer', () => {
    expect(parseDiffVerdict('```json\n{"rationale":"ok","solves_same_task":true,"regressions":false}\n```')).toEqual({ solves: true, regressions: false });
    expect(parseDiffVerdict('<think>{"x":1}</think>{"solves_same_task":false,"regressions":true}')).toEqual({ solves: false, regressions: true });
    expect(parseDiffVerdict('no json')).toBeUndefined();
  });
});

// ───────────────────────── plan, flags, command guards ─────────────────────────

const candidate = (id: string, est: Record<string, number>, over: Partial<Candidate> = {}): Candidate => ({
  taskId: id,
  project: '~/p',
  repoRoot: '/r',
  relCwd: '',
  branch: 'main',
  commit: 'c'.repeat(40),
  commitTs: 0,
  dirtyStart: false,
  dirtyReasons: [],
  originalEdited: true,
  l1Cheaper: false,
  estUsd: est,
  ...over,
});

describe('plan', () => {
  it('detects the account from the environment', () => {
    expect(detectAccount({ ANTHROPIC_API_KEY: 'k' })).toBe('api-key');
    expect(detectAccount({})).toBe('subscription');
    expect(detectAccount({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('cloud');
  });
  it('multiplies tasks x ladder x samples into a low..high range and flags a budget shortfall', () => {
    const l = parseLadder('haiku-low,opus-medium');
    const cs = [candidate('a', { 'haiku-low': 0.1, 'opus-medium': 1 }), candidate('b', { 'haiku-low': 0.2, 'opus-medium': 2 }, { testCommand: { kind: 'npm', command: 'npm test' } })];
    const p = buildPlan({ candidates: cs, ladder: l, samples: 2, budgetUsd: 5, env: {} });
    expect(p.maxRuns).toBe(8);
    expect(p.lowUsd).toBeCloseTo(0.6);
    expect(p.highUsd).toBeCloseTo(6.6);
    expect(p.exceedsBudget).toBe(true);
    expect(p.account).toBe('subscription');
    expect(p.dailyCap).toBe(undefined);
    expect(p.withTests).toBe(1);
    expect(buildPlan({ candidates: cs, ladder: l, samples: 1, budgetUsd: 50, env: { ANTHROPIC_API_KEY: 'k' } }).exceedsBudget).toBe(false);
  });
});

describe('flag guards', () => {
  const f = (o: Record<string, string | true>): Map<string, string | true> => new Map(Object.entries(o));
  it('requires --max-tasks and --budget-usd (except for --select)', () => {
    expect(() => parseReplayFlags(f({}))).toThrow(/--max-tasks/);
    expect(() => parseReplayFlags(f({ 'max-tasks': '5' }))).toThrow(/--budget-usd/);
    expect(() => parseReplayFlags(f({ 'max-tasks': '5', 'budget-usd': '0' }))).toThrow(/--budget-usd/);
    expect(() => parseReplayFlags(f({ 'max-tasks': '0', 'budget-usd': '5' }))).toThrow(/--max-tasks/);
    expect(parseReplayFlags(f({ select: true })).select).toBe(true);
  });
  it('defaults: 2 samples, default ladder, safe bash, install off, dirty and L1 preference off', () => {
    const o = parseReplayFlags(f({ 'max-tasks': '5', 'budget-usd': '3' }));
    expect(o).toMatchObject({ samples: 2, bash: 'safe', install: false, includeDirty: false, preferL1: false, judgeDiff: false, yes: false, dryRun: false, maxTurns: undefined });
    expect(o.ladder.map((c) => c.id)).toEqual(['haiku-low', 'sonnet-medium', 'sonnet-high', 'opus-medium']);
    expect(o.runTimeoutMs).toBe(1_200_000);
  });
  it('--judge-diff needs a judge backend and model', () => {
    const base = { 'max-tasks': '5', 'budget-usd': '3', 'judge-diff': true as const };
    expect(() => parseReplayFlags(f(base))).toThrow(/--judge-backend/);
    expect(() => parseReplayFlags(f({ ...base, 'judge-backend': 'claude' }))).toThrow(/--judge-model/);
    expect(() => parseReplayFlags(f({ ...base, 'judge-backend': 'openai', 'judge-model': 'm' }))).toThrow(/--judge-base-url/);
    expect(parseReplayFlags(f({ ...base, 'judge-backend': 'claude', 'judge-model': 'opus' })).judgeDiff).toBe(true);
  });
  it('rejects a bad --bash, --ladder and --samples', () => {
    const base = { 'max-tasks': '5', 'budget-usd': '3' };
    expect(() => parseReplayFlags(f({ ...base, bash: 'yolo' }))).toThrow(/--bash/);
    expect(() => parseReplayFlags(f({ ...base, ladder: 'turbo-low' }))).toThrow(/--ladder/);
    expect(() => parseReplayFlags(f({ ...base, samples: '0' }))).toThrow(/--samples/);
  });
});

// ───────────────────────── the command, end to end with mocks ─────────────────────────

describe('datasetReplayCmd', () => {
  let home: string;
  let repo: string;
  let out: string[];
  let err: string[];
  let requests: RunRequest[];
  let shells: string[];
  let gitCalls: string[][];

  const writeTasks = (s: SessionData): void => {
    mkdirSync(join(home, 'dataset'), { recursive: true });
    writeFileSync(join(home, 'dataset', 'tasks.jsonl'), buildSessionRecords(s).records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };

  beforeEach(() => {
    home = join(tmp, 'home');
    repo = makeRepo();
    out = [];
    err = [];
    requests = [];
    shells = [];
    gitCalls = [];
  });

  const baseDeps = (over: Partial<Parameters<typeof datasetReplayCmd>[2]> = {}, s: SessionData = session({ cwd: repo })): NonNullable<Parameters<typeof datasetReplayCmd>[2]> => ({
    env: { AGENTO_HOME: home },
    stdout: { write: (x) => out.push(x), isTTY: false, columns: 100 },
    stderr: { write: (x) => err.push(x), isTTY: false },
    corpusLoader: async () => corpusOf(s),
    runner: async (r) => {
      requests.push(r);
      writeFileSync(join(r.cwd, 'agent-edit.txt'), 'edited\n'); // the "agent" changes the worktree
      return { kind: 'result', isError: false, costUsd: 0.1, numTurns: 3, durationMs: 500 };
    },
    shell: async (cmd) => {
      shells.push(cmd);
      return { code: 0, timedOut: false };
    },
    git: ((cwd, args) => (gitCalls.push([...args]), runGit(cwd, args))) as GitFn,
    installHandlers: false,
    now: () => T0 + 86_400_000,
    ...over,
  });

  const flags = (o: Record<string, string | true>): Map<string, string | true> => new Map(Object.entries({ 'no-color': true as string | true, lang: 'en', ...o }));
  const text = (): string => out.join('');

  it('refuses without --max-tasks / --budget-usd before reading anything', async () => {
    await expect(datasetReplayCmd(flags({}), 'en', baseDeps())).rejects.toThrow(/--max-tasks/);
    await expect(datasetReplayCmd(flags({ 'max-tasks': '3' }), 'en', baseDeps())).rejects.toThrow(/--budget-usd/);
    expect(requests).toEqual([]);
  });

  it('--dry-run prints selection and plan, runs nothing and creates no worktree', async () => {
    writeTasks(session({ cwd: repo }));
    const code = await datasetReplayCmd(flags({ 'dry-run': true, 'max-tasks': '40', 'budget-usd': '20' }), 'en', baseDeps());
    expect(code).toBe(0);
    expect(requests).toEqual([]);
    expect(shells).toEqual([]);
    expect(gitCalls.some((a) => a[0] === 'worktree')).toBe(false);
    expect(git(repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
    const t = text();
    expect(t).toContain('Dry run');
    expect(t).toContain('replayable');
    expect(t).toContain('Plan');
    expect(t).toContain('haiku·low → sonnet·medium → sonnet·high → opus·medium');
    expect(t).toContain('subscription'); // no ANTHROPIC_API_KEY in the mocked env
  });

  it('--dry-run reports the API key account when ANTHROPIC_API_KEY is present', async () => {
    writeTasks(session({ cwd: repo }));
    await datasetReplayCmd(flags({ 'dry-run': true, 'max-tasks': '1', 'budget-usd': '5' }), 'en', baseDeps({ env: { AGENTO_HOME: home, ANTHROPIC_API_KEY: 'sk-test' } }));
    expect(text()).toContain('API key');
  });

  it('--select needs neither budget nor max-tasks and lists skip reasons', async () => {
    writeTasks(session({ cwd: join(tmp, 'gone') }));
    const code = await datasetReplayCmd(flags({ select: true }), 'en', baseDeps({}, session({ cwd: join(tmp, 'gone') })));
    expect(code).toBe(0);
    expect(text()).toContain('project directory no longer exists');
  });

  it('refuses a real run without a terminal and without --yes: nothing runs', async () => {
    writeTasks(session({ cwd: repo }));
    const code = await datasetReplayCmd(flags({ 'max-tasks': '1', 'budget-usd': '5' }), 'en', baseDeps({ interactive: false }));
    expect(code).toBe(1);
    expect(err.join('')).toContain('--yes');
    expect(requests).toEqual([]);
    expect(gitCalls.some((a) => a[0] === 'worktree')).toBe(false);
  });

  it('a declined confirmation spends nothing', async () => {
    writeTasks(session({ cwd: repo }));
    const code = await datasetReplayCmd(flags({ 'max-tasks': '1', 'budget-usd': '5' }), 'en', baseDeps({ confirm: async () => false }));
    expect(code).toBe(1);
    expect(requests).toEqual([]);
  });

  it('with --yes: replays in a worktree, writes runs and a label, removes the worktree, stores no prompt text', async () => {
    writeTasks(session({ cwd: repo }));
    const code = await datasetReplayCmd(flags({ yes: true, 'max-tasks': '1', 'budget-usd': '5' }), 'en', baseDeps());
    expect(code).toBe(0);
    // haiku-low passes both samples: the cheapest rung
    expect(requests.map((r) => `${r.tier}/${r.effort}`)).toEqual(['haiku/low', 'haiku/low']);
    expect(requests[0]!.prompt).toBe('fix the bug in src.txt');
    expect(requests[0]!.cwd).not.toBe(repo);
    expect(requests[0]!.cwd).toContain('agento-replay-');
    expect(shells.filter((c) => c === 'npm test')).toHaveLength(3); // baseline + 2 samples
    const dir = join(home, 'dataset', 'replay');
    const runs = readRuns(dir);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ config: 'haiku-low', pass: true, costUsd: 0.1, numTurns: 3 });
    const labels = readLabels(dir);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ l2Tier: 'haiku', l2Effort: 'low', costUsd: 0.2 });
    expect(labels[0]!.l2Evidence).toMatchObject({ passedConfig: 'haiku-low', testBaseline: 'pass', testCommand: 'npm test', checks: ['tests', 'diff'] });
    const files = readFileSync(join(dir, 'runs.jsonl'), 'utf8') + readFileSync(join(dir, 'labels.jsonl'), 'utf8');
    expect(files).not.toContain('fix the bug');
    // sandbox: worktree gone, user's repo untouched
    expect(git(repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(repo, 'agent-edit.txt'))).toBe(false);
    expect(text()).toContain('L2 labels');
    expect(text()).toContain('haiku·low');
  });

  it('resumes: a second invocation finds the label and replays nothing', async () => {
    writeTasks(session({ cwd: repo }));
    const f = flags({ yes: true, 'max-tasks': '1', 'budget-usd': '5' });
    await datasetReplayCmd(f, 'en', baseDeps());
    requests.length = 0;
    out.length = 0;
    await datasetReplayCmd(f, 'en', baseDeps());
    expect(requests).toEqual([]);
    expect(text()).toContain('Nothing to replay');
  });

  it('stops on budget: the run that does not fit never starts, no label is written', async () => {
    writeTasks(session({ cwd: repo }));
    // runner "costs" 0.1 and fails every check; the budget leaves room for only a few runs
    const failing = baseDeps({
      runner: async (r) => (requests.push(r), { kind: 'result', isError: false, costUsd: 0.1, numTurns: 1, durationMs: 1 }), // no edit: diff check fails
    });
    const code = await datasetReplayCmd(flags({ yes: true, 'max-tasks': '1', 'budget-usd': '0.12', ladder: 'haiku-low,sonnet-medium', samples: '2' }), 'en', failing);
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.length).toBeLessThan(4);
    expect(readLabels(join(home, 'dataset', 'replay'))).toHaveLength(0);
    expect(text()).toContain('stopped');
    expect(text()).toContain('remaining budget');
    expect(git(repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  it('removes the worktree even when the runner crashes mid-ladder', async () => {
    writeTasks(session({ cwd: repo }));
    const crashing = baseDeps({ runner: async () => Promise.reject(new Error('runner crashed')) });
    await expect(datasetReplayCmd(flags({ yes: true, 'max-tasks': '1', 'budget-usd': '5' }), 'en', crashing)).rejects.toThrow('runner crashed');
    expect(git(repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  it('three infrastructure errors in a row stop the whole run with exit code 1 and no fake labels', async () => {
    const s = [session({ cwd: repo, sessionId: 'a' }), session({ cwd: repo, sessionId: 'b' }), session({ cwd: repo, sessionId: 'c' }), session({ cwd: repo, sessionId: 'd' })];
    mkdirSync(join(home, 'dataset'), { recursive: true });
    writeFileSync(join(home, 'dataset', 'tasks.jsonl'), s.flatMap((x) => buildSessionRecords(x).records).map((r) => JSON.stringify(r)).join('\n') + '\n');
    const broken = baseDeps({ corpusLoader: async () => corpusOf(...s), runner: async (r) => (requests.push(r), { kind: 'error', isError: true, costUsd: 0, numTurns: 0, durationMs: 1, error: 'not logged in' }) });
    const code = await datasetReplayCmd(flags({ yes: true, 'max-tasks': '4', 'budget-usd': '5' }), 'en', broken);
    expect(code).toBe(1);
    expect(requests).toHaveLength(3); // the fourth task is never started
    expect(readLabels(join(home, 'dataset', 'replay'))).toHaveLength(0);
    expect(text()).toContain('no verdict');
  });
});

// ───────────────────────── store, summary, render ─────────────────────────

describe('store', () => {
  it('appends one line per record, survives a torn last line, keys runs by task/config/sample', () => {
    const p = join(tmp, 'runs.jsonl');
    appendJsonl(p, rec('haiku-low', 1, true));
    writeFileSync(p, readFileSync(p, 'utf8') + '{"taskId":"t1","conf'); // crash mid-write
    appendJsonl(p, rec('haiku-low', 2, false));
    const runs = readRuns(tmp);
    expect(runs.map((r) => r.sample)).toEqual([1, 2]);
    expect(priorRunMap(runs).get(runKey('t1', 'haiku-low', 2))?.pass).toBe(false);
    expect(readLabels(join(tmp, 'none'))).toEqual([]);
  });
});

describe('summary and rendering', () => {
  const baseTask = (id: string, tier = 'opus'): TaskRecord => ({ ...buildSessionRecords(session({ sessionId: id })).records[0]!, taskId: id, observed: { ...buildSessionRecords(session({ sessionId: id })).records[0]!.observed, modelTier: tier } });
  const label = (id: string, tier: 'haiku' | 'sonnet' | 'opus', effort: 'low' | 'medium' | 'high', none = false) => ({
    v: 1 as const,
    taskId: id,
    ts: 1,
    l2Tier: tier,
    l2Effort: effort,
    l2Evidence: { passedConfig: none ? null : `${tier}-${effort}`, steps: [], checks: ['diff' as const], commit: 'c', samples: 2 },
    costUsd: 0.5,
  });
  const l1 = (tier: 'haiku' | 'sonnet' | 'opus'): { l1Probs: Record<string, number> } => ({
    l1Probs: tier === 'haiku' ? { 'haiku-low': 0.9, 'sonnet-medium': 0.9, 'sonnet-high': 0.9, 'opus-medium': 0.9 } : tier === 'sonnet' ? { 'haiku-low': 0.1, 'sonnet-medium': 0.9, 'sonnet-high': 0.9, 'opus-medium': 0.9 } : { 'haiku-low': 0.1, 'sonnet-medium': 0.1, 'sonnet-high': 0.1, 'opus-medium': 0.9 },
  });

  const build = () =>
    summarizeReplay({
      tasks: [baseTask('a'), baseTask('b'), baseTask('c'), baseTask('d', 'sonnet')],
      labels: new Map([
        ['a', label('a', 'haiku', 'low')],
        ['b', label('b', 'sonnet', 'medium')],
        ['c', label('c', 'opus', 'medium', true)],
      ]),
      thisRun: { selected: 3, replayed: 3, labeledNow: 3, inconclusive: 0, skipped: { 'dirty-start': 4, 'not-a-repo': 2 }, runs: [rec('haiku-low', 1, true), rec('haiku-low', 2, false, { judgeCostUsd: 0.02 })] },
      l1: { file: '/j/claude-opus.jsonl', threshold: 0.7, verdicts: new Map([['a', l1('haiku')], ['b', l1('haiku')], ['c', l1('sonnet')]]) as never },
      dir: '/d',
      budgetUsd: 10,
      durationMs: 1500,
    });

  it('aggregates label distribution, observed vs L2 and L1 vs L2 (under- and over-routing)', () => {
    const s = build();
    expect(s.labeledTotal).toBe(3);
    expect(s.ladder).toEqual({ 'haiku-low': 1, 'sonnet-medium': 1, 'opus-medium': 1 });
    expect(s.fallback).toBe(1);
    expect(s.observedVsL2.opus).toEqual({ haiku: 1, sonnet: 1, opus: 1 });
    expect(s.l1).toMatchObject({ compared: 3, exact: 1, sameTier: 1, l1Cheaper: 2, l1Dearer: 0 }); // a exact; b: haiku<sonnet; c: sonnet-medium<opus-medium
    expect(s.runs).toMatchObject({ count: 2, passed: 1, judgeUsd: 0.02 });
    expect(s.skippedTotal).toBe(6);
  });

  it.each(['en', 'ru'] as const)('renders the summary in %s with all sections and no prompt text', (lang) => {
    const t = renderReplaySummary(build(), { color: 'none', width: 90, lang }, { runs: '/d/runs.jsonl', labels: '/d/labels.jsonl' });
    expect(t).toContain('agento dataset replay');
    expect(t).toContain('L1');
    expect(t).toContain('L2');
    expect(t).toContain('haiku·low');
    expect(t).toContain(lang === 'en' ? 'judge validation' : 'проверка судьи');
    expect(t).toContain('$');
    for (const line of t.split('\n')) expect(line.length).toBeLessThan(200);
  });

  it('says so when there is no judge file', () => {
    const s = { ...build(), l1: undefined };
    expect(renderReplaySummary(s, { color: 'none', width: 90, lang: 'en' }, { runs: 'r', labels: 'l' })).toContain('No judge file');
  });

  it('renders the dry-run plan with skip reasons, the cost range and the account', () => {
    const cs = [candidate('a', { 'haiku-low': 0.1, 'opus-medium': 1 }, { testCommand: { kind: 'npm', command: 'npm test' } })];
    const plan = buildPlan({ candidates: cs, ladder: parseLadder('haiku-low,opus-medium'), samples: 2, budgetUsd: 20, env: {} });
    const t = renderPlan({ mode: 'dry-run', totalTasks: 10, selectedTotal: 1, candidates: cs, skippedByReason: { 'dirty-start': 5, 'cwd-missing': 4 }, dirty: 5, plan, judgeDiff: false }, { color: 'none', width: 90, lang: 'en' });
    expect(t).toContain('working tree was dirty');
    expect(t).toContain('project directory no longer exists');
    expect(t).toContain('$0.20'); // low: 0.1 x 2 samples
    expect(t).toContain('$20.00');
    expect(t).toContain('subscription');
    expect(t).toContain('Without --judge-diff');
  });
});
