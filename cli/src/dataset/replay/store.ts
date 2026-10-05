// runs.jsonl (every run) and labels.jsonl (one per task) under $AGENTO_HOME/dataset/replay/. Appended one line per write; a torn
// last line from a crash is closed and ignored on read. No prompt text is ever stored.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentoHome } from '../write.ts';
import type { LabelRecord, RunRecord } from './types.ts';

export function replayDir(env: Record<string, string | undefined> = process.env): string {
  return join(agentoHome(env), 'dataset', 'replay');
}

export const runsPath = (dir: string): string => join(dir, 'runs.jsonl');
export const labelsPath = (dir: string): string => join(dir, 'labels.jsonl');

export function readJsonl<T extends { taskId: string }>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as T;
      if (r && typeof r.taskId === 'string') out.push(r);
    } catch {
      // torn line
    }
  }
  return out;
}

export function appendJsonl(path: string, rec: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  let prefix = '';
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size > 0 && readFileSync(path).subarray(size - 1, size).toString('utf8') !== '\n') prefix = '\n';
  }
  appendFileSync(path, prefix + JSON.stringify(rec) + '\n', { mode: 0o600 });
}

export const readRuns = (dir: string): RunRecord[] => readJsonl<RunRecord>(runsPath(dir));
export const readLabels = (dir: string): LabelRecord[] => readJsonl<LabelRecord>(labelsPath(dir));

// Latest label per taskId.
export function labelMap(records: readonly LabelRecord[]): Map<string, LabelRecord> {
  const m = new Map<string, LabelRecord>();
  for (const r of records) m.set(r.taskId, r);
  return m;
}

export const runKey = (taskId: string, config: string, sample: number): string => `${taskId}|${config}|${sample}`;

// Finished runs (a verdict, not an infrastructure error) by task/config/sample; the last one wins. Used to resume a half-done ladder.
export function priorRunMap(records: readonly RunRecord[]): Map<string, RunRecord> {
  const m = new Map<string, RunRecord>();
  for (const r of records) if (r.status !== 'error') m.set(runKey(r.taskId, r.config, r.sample), r);
  return m;
}

// Runs written since local midnight (for the daily cap on a subscription).
export function runsToday(records: readonly RunRecord[], now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return records.filter((r) => r.ts >= d.getTime()).length;
}
