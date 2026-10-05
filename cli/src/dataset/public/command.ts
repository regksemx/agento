// `agento dataset import twinrouterbench` and `agento dataset validate-judge`: flag parsing, files, output. cli.ts only wires this in.

import { existsSync, readFileSync } from 'node:fs';
import { detectColor } from '../../report/theme.ts';
import type { Lang } from '../../report/i18n.ts';
import { DEFAULT_THRESHOLD } from '../judge/label.ts';
import { judgedMap, readJudgeFile } from '../judge/store.ts';
import { isPublicTask, type PublicTaskRecord } from '../types.ts';
import { writeFileAtomic } from '../write.ts';
import type { GitFn } from '../replay/git.ts';
import { defaultPublicPath, importTwinRouterBench } from './import.ts';
import { renderImportSummary, renderValidation } from './render.ts';
import { resolveSource } from './source.ts';
import { DEFAULT_MAX_UNDER, validateJudge } from './validate.ts';

export type Flags = Map<string, string | true>;

export interface PublicDeps {
  env?: Record<string, string | undefined>;
  stdout?: { write(s: string): unknown; columns?: number; isTTY?: boolean };
  stderr?: { write(s: string): unknown };
  gitFn?: GitFn;
}

const strFlag = (flags: Flags, k: string): string | undefined => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);

function renderOpts(flags: Flags, deps: PublicDeps, lang: Lang) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  return { color: flags.has('no-color') ? ('none' as const) : detectColor(env, Boolean(stdout.isTTY)), width: Math.max(64, Math.min(100, stdout.columns ?? 80)), lang };
}

export function datasetImportCmd(what: string | undefined, flags: Flags, lang: Lang, deps: PublicDeps = {}): number {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (what !== 'twinrouterbench') {
    stderr.write(`agento: unknown dataset to import "${what ?? ''}" (expected: twinrouterbench)\n`);
    return 1;
  }
  try {
    const source = resolveSource({ source: strFlag(flags, 'source'), fetch: flags.has('fetch'), env, gitFn: deps.gitFn });
    const out = strFlag(flags, 'out') ?? defaultPublicPath(env);
    const { summary } = importTwinRouterBench({ source, out });
    stdout.write(renderImportSummary(summary, renderOpts(flags, deps, lang)) + '\n');
    return summary.records > 0 ? 0 : 1;
  } catch (e) {
    stderr.write(`agento: ${(e as Error).message}\n`);
    return 1;
  }
}

export function readPublicTasks(path: string): PublicTaskRecord[] {
  const out: PublicTaskRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.taskId === 'string' && isPublicTask(r) && typeof r.l2Tier === 'string' && r.l2Evidence) out.push(r);
    } catch {
      // skip a damaged line
    }
  }
  return out;
}

export function datasetValidateJudgeCmd(flags: Flags, lang: Lang, deps: PublicDeps = {}): number {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const judgePath = strFlag(flags, 'judge');
    if (!judgePath) throw new Error('--judge <judge.jsonl> is required (the file written by `agento dataset judge`)');
    const labelsPath = strFlag(flags, 'labels') ?? defaultPublicPath(env);
    if (!existsSync(judgePath)) throw new Error(`cannot read ${judgePath}`);
    if (!existsSync(labelsPath)) throw new Error(`cannot read ${labelsPath}: run \`agento dataset import twinrouterbench\` first or pass --labels`);
    const thr = strFlag(flags, 'threshold');
    const threshold = thr === undefined ? DEFAULT_THRESHOLD : Number(thr);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error('--threshold: expected a number in (0, 1]');
    const mu = strFlag(flags, 'max-under');
    const maxUnder = mu === undefined ? DEFAULT_MAX_UNDER : Number(mu);
    if (!Number.isFinite(maxUnder) || maxUnder < 0 || maxUnder > 1) throw new Error('--max-under: expected a number in [0, 1]');
    const bench = strFlag(flags, 'benchmark');

    const labels = readPublicTasks(labelsPath);
    const summary = validateJudge({
      labels,
      verdicts: judgedMap(readJudgeFile(judgePath)),
      judgeFile: judgePath,
      labelsFile: labelsPath,
      threshold,
      maxUnder,
      benchmarks: bench ? bench.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    });
    stdout.write(renderValidation(summary, renderOpts(flags, deps, lang)) + '\n');
    const outPath = strFlag(flags, 'out');
    if (outPath) writeFileAtomic(outPath, JSON.stringify(summary, null, 2) + '\n');
    return summary.compared > 0 ? 0 : 1;
  } catch (e) {
    stderr.write(`agento: ${(e as Error).message}\n`);
    return 1;
  }
}

