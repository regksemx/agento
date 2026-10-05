// The judge output file: one JSON line per verdict, appended with a single write per line.
// Reading tolerates a torn last line (a crash mid-append) and duplicates: the last ok record of a taskId wins.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentoHome } from '../write.ts';
import type { JudgeBackendKind, JudgeRecord, JudgeRecordOk } from './types.ts';

export function judgeDir(env: Record<string, string | undefined> = process.env): string {
  return join(agentoHome(env), 'dataset', 'judge');
}

// `<backend>-<model>.jsonl`; anything outside [A-Za-z0-9._-] in the model name becomes `_`.
export function judgeFileName(backend: JudgeBackendKind, model: string): string {
  return `${backend}-${model.replace(/[^A-Za-z0-9._-]+/g, '_')}.jsonl`;
}

export function defaultJudgePath(backend: JudgeBackendKind, model: string, env: Record<string, string | undefined> = process.env): string {
  return join(judgeDir(env), judgeFileName(backend, model));
}

export function parseJudgeLines(text: string): JudgeRecord[] {
  const out: JudgeRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as JudgeRecord;
      if (r && typeof r.taskId === 'string' && typeof r.ok === 'boolean') out.push(r);
    } catch {
      // torn line: skip
    }
  }
  return out;
}

export function readJudgeFile(path: string): JudgeRecord[] {
  return existsSync(path) ? parseJudgeLines(readFileSync(path, 'utf8')) : [];
}

// Latest successful verdict per taskId. Failure records never count as judged, so a later run retries them.
export function judgedMap(records: readonly JudgeRecord[]): Map<string, JudgeRecordOk> {
  const m = new Map<string, JudgeRecordOk>();
  for (const r of records) if (r.ok) m.set(r.taskId, r);
  return m;
}

// Appends one record as a single write, so concurrent workers of one process never interleave lines.
export function appendJudgeRecord(path: string, rec: JudgeRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  let prefix = '';
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size > 0) {
      const last = readFileSync(path).subarray(size - 1, size).toString('utf8');
      if (last !== '\n') prefix = '\n'; // a previous run died mid-line: close it so the new record stands alone
    }
  }
  appendFileSync(path, prefix + JSON.stringify(rec) + '\n', { mode: 0o600 });
}
