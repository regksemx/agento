// The human-label file: one JSON line per verdict, appended with a single write. Re-labeling appends again: the last record
// of a taskId wins (the training export merges lines in order, so its last write wins too). Tolerates a torn last line.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';
import { agentoHome } from '../write.ts';
import { judgeDir } from '../judge/store.ts';
import type { L1Guess } from './types.ts';
import { EFFORTS, HUMAN_FILE, HUMAN_SCHEMA_VERSION, TIERS, type HumanRecord } from './types.ts';

export function humanPath(env: Record<string, string | undefined> = process.env): string {
  return join(judgeDir(env), HUMAN_FILE);
}

export function parseHumanLines(text: string): HumanRecord[] {
  const out: HumanRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as HumanRecord;
      if (r && typeof r.taskId === 'string' && r.ok === true) out.push(r);
    } catch {
      // torn line: skip
    }
  }
  return out;
}

export function readHumanFile(path: string): HumanRecord[] {
  return existsSync(path) ? parseHumanLines(readFileSync(path, 'utf8')) : [];
}

// Latest record per taskId (replace semantics).
export function humanMap(records: readonly HumanRecord[]): Map<string, HumanRecord> {
  const m = new Map<string, HumanRecord>();
  for (const r of records) m.set(r.taskId, r);
  return m;
}

export function readHumanLabels(path: string): Map<string, HumanRecord> {
  return humanMap(readHumanFile(path));
}

// Appends one record as a single write. A previous crash mid-line is closed first so the new record stands alone.
export function appendHumanRecord(path: string, rec: HumanRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  let prefix = '';
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size > 0 && readFileSync(path).subarray(size - 1, size).toString('utf8') !== '\n') prefix = '\n';
  }
  appendFileSync(path, prefix + JSON.stringify(rec) + '\n', { mode: 0o600 });
}

export interface Answers {
  tier: TaskTier;
  effort: TaskEffort;
  plan: boolean;
  delegate: boolean;
}

export function makeRecord(taskId: string, a: Answers | 'unsure', seconds: number, now: number): HumanRecord {
  return {
    v: HUMAN_SCHEMA_VERSION,
    taskId,
    ok: true,
    ts: now,
    labelSource: 'human',
    labeledAt: new Date(now).toISOString(),
    labelerSeconds: Math.max(0, Math.min(3600, Math.round(seconds))),
    unsure: a === 'unsure',
    l2Tier: a === 'unsure' ? null : a.tier,
    l2Effort: a === 'unsure' ? null : a.effort,
    l2PlanFirst: a === 'unsure' ? null : a.plan,
    l2DelegateExplore: a === 'unsure' ? null : a.delegate,
  };
}

// The newest L1 judge file in the judge dir (never human.jsonl), unless `explicit` names one. A judge process may be
// appending to it right now: reading is fine, a torn last line is skipped.
export function findJudgeFile(explicit: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  if (explicit) return explicit;
  const dir = judgeDir(env);
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && f !== HUMAN_FILE)
      .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }));
    return files.sort((a, b) => b.m - a.m)[0]?.f;
  } catch {
    return undefined;
  }
}

// taskId -> the judge's tier/effort/flags, from the latest ok verdict of the file.
export function readL1Guesses(path: string | undefined): Map<string, L1Guess> {
  const m = new Map<string, L1Guess>();
  if (!path || !existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.ok !== true || typeof r.taskId !== 'string') continue;
      const tier = r.l1Tier as TaskTier;
      const effort = r.l1Effort as TaskEffort;
      if (!TIERS.includes(tier) || !EFFORTS.includes(effort)) continue;
      m.set(r.taskId, {
        tier,
        effort,
        ...(typeof r.needsPlanFirst === 'boolean' ? { planFirst: r.needsPlanFirst } : {}),
        ...(typeof r.delegateExplore === 'boolean' ? { delegateExplore: r.delegateExplore } : {}),
      });
    } catch {
      // skip
    }
  }
  return m;
}

export { agentoHome };

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// CSV for review. No prompt text: only ids, project, the human answers and the guesses.
export const CSV_HEADER = ['taskId', 'project', 'date', 'humanTier', 'humanEffort', 'planFirst', 'delegateExplore', 'unsure', 'seconds', 'l0Tier', 'l0Effort', 'rulesTier', 'rulesEffort', 'l1Tier', 'l1Effort', 'observedModel', 'observedEffort', 'costUsd'];

export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
