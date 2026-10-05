// `agento dataset label`: flag parsing, sampling, the interactive session, the report and the CSV export.
// cli.ts only wires this in. Everything with side effects is injectable so tests never need a terminal.

import { writeFileSync } from 'node:fs';
import { detectColor } from '../../report/theme.ts';
import type { Lang } from '../../report/i18n.ts';
import { defaultOutPath } from '../write.ts';
import { readTasks } from '../judge/command.ts';
import { labelStrings } from './i18n.ts';
import { computeReport } from './metrics.ts';
import { renderCard, renderLabelReport } from './render.ts';
import { sampleTasks, STRATEGIES, type Strategy } from './sample.ts';
import { runSession, type KeyInput } from './session.ts';
import { appendHumanRecord, findJudgeFile, humanPath, makeRecord, readHumanLabels, readL1Guesses, toCsv } from './store.ts';
import type { L1Guess } from './types.ts';

export type Flags = Map<string, string | true>;

export interface LabelDeps {
  env?: Record<string, string | undefined>;
  stdin?: KeyInput & { isTTY?: boolean };
  stdout?: { write(s: string): unknown; columns?: number; rows?: number; isTTY?: boolean };
  stderr?: { write(s: string): unknown };
  now?: () => number;
}

export interface LabelOptions {
  n: number;
  strategy: Strategy;
  seed: number;
  report: boolean;
  exportCsv?: string | true; // true: stdout
  tasksPath: string;
  judgePath?: string;
  outPath: string;
}

export function parseLabelFlags(flags: Flags, env: Record<string, string | undefined> = process.env): LabelOptions {
  const str = (k: string): string | undefined => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
  const nRaw = str('n');
  const n = nRaw === undefined ? 50 : Number(nRaw);
  if (!Number.isInteger(n) || n < 1) throw new Error('--n: expected a positive integer');
  const strategy = (str('strategy') ?? 'stratified') as Strategy;
  if (!STRATEGIES.includes(strategy)) throw new Error(`--strategy: expected ${STRATEGIES.join(', ')}`);
  const seedRaw = str('seed');
  const seed = seedRaw === undefined ? 1 : Number(seedRaw);
  if (!Number.isInteger(seed)) throw new Error('--seed: expected an integer');
  const csv = flags.get('export-csv');
  return {
    n,
    strategy,
    seed,
    report: flags.has('report'),
    exportCsv: csv === undefined ? undefined : csv,
    tasksPath: str('tasks') ?? defaultOutPath(env),
    judgePath: str('judge'),
    outPath: str('out') ?? humanPath(env),
  };
}

export async function datasetLabelCmd(flags: Flags, lang: Lang, deps: LabelDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const stdin = deps.stdin ?? process.stdin;
  const now = deps.now ?? Date.now;
  const o = parseLabelFlags(flags, env);
  const D = labelStrings(lang);
  const color = flags.has('no-color') ? 'none' : detectColor(env, Boolean(stdout.isTTY));
  const width = Math.max(64, Math.min(100, stdout.columns ?? 80));
  const ropts = { color, width, lang } as const;

  const tasks = readTasks(o.tasksPath);
  const l1: Map<string, L1Guess> = readL1Guesses(findJudgeFile(o.judgePath, env));
  let human = readHumanLabels(o.outPath);
  const report = (sessionSaved?: number): string => renderLabelReport(computeReport(tasks, human, l1), { generatedAt: new Date(now()).toISOString(), path: o.outPath, sessionSaved }, ropts);

  if (o.exportCsv !== undefined) {
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    const rows: unknown[][] = [];
    for (const h of human.values()) {
      const t = byId.get(h.taskId);
      if (!t) continue;
      const g = l1.get(t.taskId);
      rows.push([t.taskId, t.project, new Date(t.startTs).toISOString().slice(0, 10), h.l2Tier, h.l2Effort, h.l2PlanFirst, h.l2DelegateExplore, h.unsure, h.labelerSeconds, t.l0Tier, t.l0Effort, t.rulesVerdict.tier, t.rulesVerdict.effort, g?.tier, g?.effort, t.observed.model, t.observed.effort, t.observed.cost]);
    }
    const csv = toCsv(rows);
    if (o.exportCsv === true) stdout.write(csv);
    else {
      writeFileSync(o.exportCsv, csv, { mode: 0o600 });
      stdout.write(D.csvWritten(o.exportCsv, String(rows.length)) + '\n');
    }
    return 0;
  }

  if (o.report) {
    stdout.write(report() + '\n');
    return 0;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write(`agento: ${D.notTty}\n`);
    return 1;
  }

  const cards = sampleTasks(tasks, { n: o.n, strategy: o.strategy, seed: o.seed, labeled: new Set(human.keys()), l1 });
  if (cards.length === 0) {
    stdout.write(D.nothingToLabel + '\n' + D.nothingHint + '\n');
    return 0;
  }

  const final = await runSession({
    input: stdin,
    output: stdout,
    total: cards.length,
    now,
    frame: (s, rows) => {
      const task = cards[s.index]!;
      return renderCard(
        { task, l1: l1.get(task.taskId), index: s.index, total: s.total, saved: s.saved, step: s.step, answers: s.answers, cursor: s.cursor, expanded: s.expanded, guesses: s.guesses, maxExpandedLines: rows ? Math.max(12, rows - 24) : undefined },
        ropts,
      );
    },
    // every verdict is on disk before the next card is drawn: quitting or Ctrl+C loses nothing
    onSave: (effect, seconds) => appendHumanRecord(o.outPath, makeRecord(cards[effect.index]!.taskId, effect.answers, seconds, now())),
  });

  human = readHumanLabels(o.outPath);
  stdout.write(report(final.saved) + '\n');
  return 0;
}
