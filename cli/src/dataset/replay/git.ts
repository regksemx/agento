// Everything that touches git for `dataset replay`: finding the starting commit, deciding whether the working tree was dirty
// then, detecting the verification command, and the throw-away worktrees the replays run in. The user's working tree is never
// written to: reads go through `git log/show/ls-tree`, writes only through `git worktree add/remove` into a temp directory.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TaskSource, TestCommand } from './types.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitFn = (cwd: string, args: readonly string[]) => GitResult;

export const runGit: GitFn = (cwd, args) => {
  const r = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const ok = (r: GitResult): string | undefined => (r.code === 0 ? r.stdout.trim() : undefined);

// ───────────────────────── repository and commit ─────────────────────────

// Top level of the repository that contains `dir`, or undefined (not a repo, git missing, directory gone).
export function repoRoot(dir: string, git: GitFn = runGit): string | undefined {
  if (!existsSync(dir)) return undefined;
  const top = ok(git(dir, ['rev-parse', '--show-toplevel']));
  if (!top) return undefined;
  try {
    return realpathSync(top);
  } catch {
    return top;
  }
}

// The local branch, else origin/<branch>, as a full ref.
export function resolveBranch(root: string, branch: string, git: GitFn = runGit): string | undefined {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code === 0) return ref;
  }
  return undefined;
}

const sec = (ms: number): number => Math.floor(ms / 1000);

// The latest commit reachable from `ref` whose commit time is <= ts (git's own `--before`).
export function commitBefore(root: string, ref: string, tsMs: number, git: GitFn = runGit): { sha: string; ts: number } | undefined {
  const out = ok(git(root, ['log', '-1', `--before=@${sec(tsMs)}`, '--format=%H %ct', ref]));
  const m = out ? /^([0-9a-f]{40}) (\d+)$/.exec(out) : null;
  return m ? { sha: m[1]!, ts: Number(m[2]) * 1000 } : undefined;
}

// A path as recorded in a transcript (absolute, or relative to the session cwd) -> path relative to the repo root; undefined outside the repo.
export function repoRelative(root: string, cwd: string, p: string): string | undefined {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const inside = (a: string): string | undefined => {
    const rel = relative(root, a);
    return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? undefined : rel.split(sep).join('/');
  };
  // transcripts record the logical path (/var/...), git the real one (/private/var/...): retry with the parent resolved
  return inside(abs) ?? inside(join(realPath(dirname(abs)), basename(abs)));
}

// macOS: /var -> /private/var. Transcripts record the logical cwd, git reports the real path.
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ───────────────────────── dirty start ─────────────────────────

const MAX_PRIOR_FILES = 60;
const MAX_EDIT_CHECKS = 20;

export interface DirtyCheck {
  dirty: boolean;
  reasons: string[]; // codes only, e.g. "uncommitted-edit", "old-string-mismatch"; never file contents
}

// Was the working tree different from `commit` when the task began? Two independent signals, either one marks it dirty:
//  1. A file the session had already modified (Edit/Write rows, `file-history-snapshot`/`-delta` rows) before the task and that has
//     no commit on or after that modification: the edit was still uncommitted at task start.
//  2. The task's own first Edit of a file has an `old_string` that does not occur in the file at `commit` (or the file is absent):
//     the file the agent saw is not the file in the commit.
// Changes the user made by hand outside any Claude session cannot be seen; signal 2 catches the ones the task then touched.
export function detectDirtyStart(root: string, cwd: string, commit: string, src: TaskSource, git: GitFn = runGit): DirtyCheck {
  const reasons: string[] = [];

  const latest = new Map<string, number>();
  for (const t of src.priorTouched) {
    const rel = repoRelative(root, cwd, t.path);
    if (rel !== undefined) latest.set(rel, Math.max(latest.get(rel) ?? 0, t.ts));
  }
  let checked = 0;
  for (const [rel, ts] of [...latest.entries()].sort((a, b) => b[1] - a[1])) {
    if (checked++ >= MAX_PRIOR_FILES) break;
    if (git(root, ['check-ignore', '-q', '--', rel]).code === 0) continue; // build output, caches: not part of the project
    const exists = git(root, ['cat-file', '-e', `${commit}:${rel}`]).code === 0;
    const after = ok(git(root, ['log', '-1', `--since=@${sec(ts)}`, '--format=%H', commit, '--', rel]));
    if (!after) {
      reasons.push(exists ? 'uncommitted-edit' : 'uncommitted-new-file');
      break;
    }
  }

  const seen = new Set<string>();
  let looked = 0;
  for (const e of src.edits) {
    const rel = repoRelative(root, cwd, e.path);
    if (rel === undefined || seen.has(rel)) continue;
    seen.add(rel);
    if (e.tool === 'Write' || !e.oldString) continue; // a Write replaces the file: nothing to compare
    if (looked++ >= MAX_EDIT_CHECKS) break;
    const blob = git(root, ['show', `${commit}:${rel}`]);
    if (blob.code !== 0) {
      reasons.push('edited-file-missing');
      break;
    }
    if (!blob.stdout.includes(e.oldString)) {
      reasons.push('old-string-mismatch');
      break;
    }
  }
  return { dirty: reasons.length > 0, reasons };
}

// ───────────────────────── verification command ─────────────────────────

const NPM_PLACEHOLDER = /no test specified|exit 1\s*$/i;

function showFile(root: string, commit: string, name: string, git: GitFn): string | undefined {
  const r = git(root, ['show', `${commit}:${name}`]);
  return r.code === 0 ? r.stdout : undefined;
}

// A test command visible in the repository root at `commit`: package.json "test" script (with the package manager the lockfile
// names), pytest, go test, cargo test, gradle, maven. Nested projects (a monorepo package) are not looked for.
export function detectTestCommand(root: string, commit: string, git: GitFn = runGit): TestCommand | undefined {
  const names = new Set((ok(git(root, ['ls-tree', '--name-only', commit])) ?? '').split('\n').filter(Boolean));
  const has = (n: string): boolean => names.has(n);

  const pkg = has('package.json') ? showFile(root, commit, 'package.json', git) : undefined;
  if (pkg !== undefined) {
    let script: unknown;
    try {
      script = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts?.test;
    } catch {
      script = undefined;
    }
    if (typeof script === 'string' && script.trim() !== '' && !NPM_PLACEHOLDER.test(script)) {
      const kind = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm';
      return { kind, command: `${kind} test` };
    }
  }
  if (has('go.mod')) return { kind: 'go', command: 'go test ./...' };
  if (has('Cargo.toml')) return { kind: 'cargo', command: 'cargo test' };
  const pytestMarked =
    has('pytest.ini') ||
    has('conftest.py') ||
    ['pyproject.toml', 'setup.cfg', 'tox.ini'].some((f) => has(f) && /pytest/i.test(showFile(root, commit, f, git) ?? ''));
  if (pytestMarked) return { kind: 'pytest', command: 'python3 -m pytest -x -q' };
  if (has('gradlew')) return { kind: 'gradle', command: './gradlew test' };
  if (has('build.gradle') || has('build.gradle.kts')) return { kind: 'gradle', command: 'gradle test' };
  if (has('pom.xml')) return { kind: 'maven', command: 'mvn -q test' };
  return undefined;
}

// The lockfile install command for `--install`; undefined when there is nothing to install (go/cargo fetch on demand).
export function installCommand(dir: string): string | undefined {
  const has = (n: string): boolean => existsSync(join(dir, n));
  if (has('package-lock.json')) return 'npm ci --no-audit --no-fund';
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (has('bun.lock') || has('bun.lockb')) return 'bun install --frozen-lockfile';
  if (has('uv.lock')) return 'uv sync --frozen';
  if (has('poetry.lock')) return 'poetry install --no-interaction';
  return undefined;
}

// ───────────────────────── worktrees ─────────────────────────

export interface Worktree {
  path: string;
  commit: string;
  remove(): void; // idempotent
}

// `git worktree add --detach <base>/<name> <commit>`; throws when git refuses.
export function createWorktree(root: string, base: string, name: string, commit: string, git: GitFn = runGit): Worktree {
  const path = join(base, name);
  const r = git(root, ['worktree', 'add', '--detach', '--force', path, commit]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim().slice(0, 200)}`);
  let removed = false;
  return {
    path,
    commit,
    remove(): void {
      if (removed) return;
      removed = true;
      git(root, ['worktree', 'remove', '--force', path]);
      rmSync(path, { recursive: true, force: true });
      git(root, ['worktree', 'prune']);
    },
  };
}

// Back to the starting commit: tracked files reset, new untracked files removed. Ignored files (node_modules, build output) stay.
export function resetWorktree(wt: { path: string; commit: string }, git: GitFn = runGit): void {
  git(wt.path, ['reset', '--hard', '--quiet', wt.commit]);
  git(wt.path, ['clean', '-fdq']);
}

export interface DiffInfo {
  files: number;
  lines: number; // added + removed
  patch: string; // unified diff, cut at maxPatch chars
}

const EXCLUDE = [':(exclude)node_modules', ':(exclude).git'];

// What the agent changed since the starting commit, new files included. Stages everything in the worktree's own index.
export function worktreeDiff(wt: { path: string; commit: string }, maxPatch = 60_000, git: GitFn = runGit): DiffInfo {
  git(wt.path, ['add', '-A', '--', '.', ...EXCLUDE]);
  const stat = git(wt.path, ['diff', '--cached', '--numstat', wt.commit, '--', '.', ...EXCLUDE]);
  let files = 0;
  let lines = 0;
  for (const l of stat.stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
    if (!m) continue;
    files += 1;
    lines += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
  }
  const patch = files > 0 ? git(wt.path, ['diff', '--cached', wt.commit, '--', '.', ...EXCLUDE]).stdout.slice(0, maxPatch) : '';
  return { files, lines, patch };
}

export function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
