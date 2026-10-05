// Where the TwinRouterBench data comes from: a local checkout / file (--source), or a git clone in $AGENTO_HOME/cache (--fetch or a URL).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runGit, type GitFn } from '../replay/git.ts';
import { agentoHome } from '../write.ts';

export const DEFAULT_REPO_URL = 'https://github.com/CommonstackAI/TwinRouterBench';
export const QUESTION_BANK = ['data/static/question_bank.jsonl', 'static/question_bank.jsonl', 'question_bank.jsonl'];

export interface ResolvedSource {
  kind: 'path' | 'git';
  input: string; // the --source value, or the default URL
  file: string; // question_bank.jsonl
  repoDir?: string; // checkout root, when the file sits in a git repository
  commit?: string;
  license?: string; // detected license of the checkout ("Apache-2.0"), when a LICENSE file is there
}

export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  return join(agentoHome(env), 'cache', 'twinrouterbench');
}

export function isGitUrl(s: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(s) || /\.git$/.test(s);
}

function findBank(dir: string): string | undefined {
  for (const rel of QUESTION_BANK) {
    const p = join(dir, rel);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined;
}

function git(g: GitFn, cwd: string, args: string[]): string {
  const r = g(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

// Clone (depth 1) into the cache, or update an existing clone.
export function fetchRepo(url: string, dir: string, g: GitFn = runGit): void {
  if (existsSync(join(dir, '.git'))) {
    git(g, dir, ['remote', 'set-url', 'origin', url]);
    git(g, dir, ['fetch', '--depth', '1', 'origin', 'HEAD']);
    git(g, dir, ['reset', '--hard', 'FETCH_HEAD']);
    return;
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} exists and is not a git checkout: remove it or pass --source`);
  mkdirSync(dirname(dir), { recursive: true });
  git(g, dirname(dir), ['clone', '--depth', '1', url, dir]);
}

function detectLicense(root: string): string | undefined {
  for (const n of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
    const p = join(root, n);
    if (!existsSync(p)) continue;
    const head = readFileSync(p, 'utf8').slice(0, 600);
    if (/Apache License/i.test(head) && /Version 2\.0/i.test(head)) return 'Apache-2.0';
    return 'unrecognized (see LICENSE)';
  }
  return undefined;
}

export function resolveSource(o: { source?: string; fetch: boolean; env?: Record<string, string | undefined>; gitFn?: GitFn }): ResolvedSource {
  const g = o.gitFn ?? runGit;
  const env = o.env ?? process.env;
  let kind: 'path' | 'git' = 'path';
  let root: string | undefined;
  let file: string | undefined;
  const input = o.source ?? DEFAULT_REPO_URL;

  if (o.source !== undefined && !isGitUrl(o.source)) {
    if (o.fetch) throw new Error('--fetch downloads the repository; do not combine it with a local --source path');
    const p = resolve(o.source);
    if (!existsSync(p)) throw new Error(`--source: ${p} does not exist`);
    if (statSync(p).isFile()) file = p;
    else {
      root = p;
      file = findBank(p);
      if (!file) throw new Error(`--source: no question_bank.jsonl under ${p} (looked for ${QUESTION_BANK.join(', ')})`);
    }
  } else {
    if (o.source === undefined && !o.fetch) {
      throw new Error('pass --source <path-or-git-url> (a checkout or question_bank.jsonl), or --fetch to clone ' + DEFAULT_REPO_URL + ' into the cache');
    }
    kind = 'git';
    root = cacheDir(env);
    fetchRepo(input, root, g);
    file = findBank(root);
    if (!file) throw new Error(`no question_bank.jsonl in the fetched repository ${root}`);
  }

  const dir = root ?? dirname(file);
  let commit: string | undefined;
  let top: string | undefined;
  try {
    top = git(g, dir, ['rev-parse', '--show-toplevel']);
    commit = git(g, top, ['rev-parse', 'HEAD']);
  } catch {
    // not a git checkout: provenance without a commit
  }
  const licenseRoot = top ?? root ?? dirname(dirname(dirname(file)));
  const license = detectLicense(licenseRoot) ?? detectLicense(dirname(file)) ?? (root ? detectLicense(root) : undefined);
  return { kind, input, file, ...(top ? { repoDir: top } : {}), ...(commit ? { commit } : {}), ...(license ? { license } : {}) };
}
