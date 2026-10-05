// Atomic file output: write a temp file next to the target, then rename over it.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export function agentoHome(env: Record<string, string | undefined> = process.env): string {
  return env.AGENTO_HOME || join(homedir(), '.agento');
}

export function defaultOutPath(env: Record<string, string | undefined> = process.env): string {
  return join(agentoHome(env), 'dataset', 'tasks.jsonl');
}

// `<dir>/summary.json` for the default `tasks.jsonl`, `<name>.summary.json` for any other file name.
export function summaryPathFor(out: string): string {
  return basename(out) === 'tasks.jsonl' ? join(dirname(out), 'summary.json') : out.replace(/(\.jsonl)?$/, '.summary.json');
}

export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r) + '\n').join('');
}
