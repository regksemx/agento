// `agento dataset build`: transcripts -> tasks.jsonl + summary.json.

import { loadCorpus } from '../transcripts.ts';
import type { Corpus } from '../types.ts';
import { buildSessionRecords } from './features.ts';
import { addHits, emptyHits } from './scrub.ts';
import { summarize, type DatasetSummary } from './summary.ts';
import type { TaskRecord } from './types.ts';
import { defaultOutPath, summaryPathFor, toJsonl, writeFileAtomic } from './write.ts';

export interface BuildOptions {
  dir: string;
  since?: number;
  sinceLabel: string; // as typed by the user ("all", "30d", ...)
  project?: string;
  out?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface BuildResult {
  summary: DatasetSummary;
  outPath: string;
  summaryPath: string;
}

export function buildRecords(corpus: Corpus): { records: TaskRecord[]; hits: ReturnType<typeof emptyHits> } {
  const records: TaskRecord[] = [];
  const hits = emptyHits();
  for (const s of corpus.sessions) {
    const r = buildSessionRecords(s);
    records.push(...r.records);
    addHits(hits, r.hits);
  }
  records.sort((a, b) => a.startTs - b.startTs || (a.taskId < b.taskId ? -1 : 1));
  return { records, hits };
}

export function writeDataset(corpus: Corpus, o: { out?: string; sinceLabel: string; project?: string; started: number }): BuildResult {
  const outPath = o.out ?? defaultOutPath();
  const summaryPath = summaryPathFor(outPath);
  const { records, hits } = buildRecords(corpus);
  writeFileAtomic(outPath, toJsonl(records));
  const summary = summarize({
    records,
    hits,
    out: outPath,
    sessions: corpus.sessions.length,
    since: o.sinceLabel,
    project: o.project,
    durationMs: Date.now() - o.started,
  });
  writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  return { summary, outPath, summaryPath };
}

export async function buildDataset(opts: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const corpus = await loadCorpus({ dir: opts.dir, since: opts.since, project: opts.project, onProgress: opts.onProgress });
  return writeDataset(corpus, { out: opts.out, sinceLabel: opts.sinceLabel, project: opts.project, started });
}
