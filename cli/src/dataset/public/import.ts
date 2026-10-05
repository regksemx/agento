// `agento dataset import twinrouterbench`: question_bank.jsonl -> $AGENTO_HOME/dataset/public/twinrouterbench.jsonl + summary json.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskTier } from '../../../../plugin/core/task.ts';
import type { PublicTaskRecord } from '../types.ts';
import { agentoHome, summaryPathFor, toJsonl, writeFileAtomic } from '../write.ts';
import { convertRow, TEXT_LIMIT, type SkipReason } from './convert.ts';
import type { ResolvedSource } from './source.ts';
import { PUBLIC_TIERS, TIER_MAP, type PublicTier } from './tier.ts';

export const NOTICE =
  'Contains data derived from TwinRouterBench (CommonstackAI), licensed under the Apache License 2.0: https://github.com/CommonstackAI/TwinRouterBench, paper https://arxiv.org/abs/2605.18859. ' +
  'Converted to the agento record format: the router-visible prefix is rendered to text and cut in the middle, the tiers are mapped to haiku/sonnet/opus (docs/public-data.md). Not endorsed by the authors.';

export const TIERS: readonly TaskTier[] = ['haiku', 'sonnet', 'opus'];

export function defaultPublicPath(env: Record<string, string | undefined> = process.env): string {
  return join(agentoHome(env), 'dataset', 'public', 'twinrouterbench.jsonl');
}

export interface ImportSummary {
  version: 1;
  generatedAt: string;
  notice: string;
  source: { kind: 'path' | 'git'; input: string; file: string; commit?: string; license?: string };
  out: string;
  records: number;
  skipped: { total: number; reasons: Record<SkipReason, number> };
  trajectories: number; // distinct benchmark/instance pairs
  benchmarks: Record<string, number>;
  publicTier: Record<PublicTier, number>;
  tier: Record<TaskTier, number>; // after the mapping
  byBenchmark: Record<string, Record<TaskTier, number>>;
  pipelineStage: Record<string, number>;
  textLimit: number;
  truncated: number; // records whose prefix was cut
  prefixChars: { mean: number; median: number; max: number }; // before the cut
  mapping: Record<PublicTier, TaskTier>;
  durationMs: number;
}

const zeroTiers = (): Record<TaskTier, number> => ({ haiku: 0, sonnet: 0, opus: 0 });

export function convertLines(text: string): { records: PublicTaskRecord[]; skipped: Record<SkipReason, number> } {
  const records: PublicTaskRecord[] = [];
  const skipped: Record<SkipReason, number> = { malformed: 0, 'no-messages': 0, 'bad-tier': 0, duplicate: 0 };
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skipped.malformed += 1;
      continue;
    }
    const r = convertRow(raw);
    if ('skip' in r) {
      skipped[r.skip] += 1;
      continue;
    }
    if (seen.has(r.taskId)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(r.taskId);
    records.push(r);
  }
  return { records, skipped };
}

export function summarizeImport(i: { records: readonly PublicTaskRecord[]; skipped: Record<SkipReason, number>; source: ResolvedSource; out: string; durationMs: number; now?: Date }): ImportSummary {
  const benchmarks: Record<string, number> = {};
  const byBenchmark: Record<string, Record<TaskTier, number>> = {};
  const publicTier = Object.fromEntries(PUBLIC_TIERS.map((t) => [t, 0])) as Record<PublicTier, number>;
  const tier = zeroTiers();
  const stage: Record<string, number> = {};
  const trajectories = new Set<string>();
  const chars: number[] = [];
  let truncated = 0;
  for (const r of i.records) {
    const e = r.l2Evidence;
    benchmarks[e.benchmark] = (benchmarks[e.benchmark] ?? 0) + 1;
    (byBenchmark[e.benchmark] ??= zeroTiers())[r.l2Tier] += 1;
    publicTier[e.publicTier as PublicTier] += 1;
    tier[r.l2Tier] += 1;
    stage[e.pipelineStage] = (stage[e.pipelineStage] ?? 0) + 1;
    trajectories.add(`${e.benchmark}/${e.instanceId}`);
    chars.push(e.prefixChars);
    if (e.truncated) truncated += 1;
  }
  chars.sort((a, b) => a - b);
  const total = Object.values(i.skipped).reduce((a, b) => a + b, 0);
  return {
    version: 1,
    generatedAt: (i.now ?? new Date()).toISOString(),
    notice: NOTICE,
    source: { kind: i.source.kind, input: i.source.input, file: i.source.file, ...(i.source.commit ? { commit: i.source.commit } : {}), ...(i.source.license ? { license: i.source.license } : {}) },
    out: i.out,
    records: i.records.length,
    skipped: { total, reasons: i.skipped },
    trajectories: trajectories.size,
    benchmarks,
    publicTier,
    tier,
    byBenchmark,
    pipelineStage: stage,
    textLimit: TEXT_LIMIT,
    truncated,
    prefixChars: { mean: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : 0, median: chars.length ? chars[Math.floor(chars.length / 2)]! : 0, max: chars.length ? chars[chars.length - 1]! : 0 },
    mapping: TIER_MAP,
    durationMs: i.durationMs,
  };
}

export function importTwinRouterBench(o: { source: ResolvedSource; out: string; now?: Date }): { summary: ImportSummary; summaryPath: string } {
  const started = Date.now();
  const { records, skipped } = convertLines(readFileSync(o.source.file, 'utf8'));
  writeFileAtomic(o.out, toJsonl(records));
  const summary = summarizeImport({ records, skipped, source: o.source, out: o.out, durationMs: Date.now() - started, now: o.now });
  const summaryPath = summaryPathFor(o.out);
  writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  return { summary, summaryPath };
}
