// Terminal output of `dataset replay`, in the visual language of the audit, `dataset build` and `dataset judge`. Pure.

import { bar, clamp, groupThousands, localStamp, money, padL, padR, pct, spread, tildify, truncateStart, visWidth, wrap } from '../../report/format.ts';
import type { Lang } from '../../report/i18n.ts';
import { makeTheme, type ColorMode, type Theme } from '../../report/theme.ts';
import { formatDuration } from '../render.ts';
import { L0_TIERS, OBSERVED_TIERS } from '../summary.ts';
import { replayStrings } from './i18n.ts';
import type { Plan } from './plan.ts';
import type { ReplaySummary } from './summary.ts';
import { SKIP_REASONS, type Candidate, type SkipReason } from './types.ts';

export interface ReplayRenderOptions {
  color: ColorMode;
  width: number;
  lang: Lang;
}

interface Kit {
  W: number;
  bw: number;
  t: Theme;
  out: string[];
  blank(): void;
  body(x: string): void;
  note(text: string): void;
  section(title: string, hint: string): void;
  n(x: number): string;
}

function kit(opts: ReplayRenderOptions): Kit {
  const W = clamp(Number.isFinite(opts.width) ? Math.floor(opts.width) : 80, 64, 100);
  const t = makeTheme(opts.color);
  const bw = W - 6;
  const out: string[] = [];
  const blank = (): void => void out.push('');
  const body = (x: string): void => void out.push('    ' + x);
  const note = (text: string): void => wrap(text, bw - 2).forEach((l, i) => body((i === 0 ? t.dim('⎿ ') : '  ') + t.dim(l)));
  const section = (title: string, hint: string): void => {
    blank();
    const left = '  ' + t.accentBold(title) + ' ';
    out.push(left + t.dim('─'.repeat(Math.max(2, W - 2 - visWidth(left)))));
    if (!hint) return blank();
    for (const l of wrap(hint, W - 4)) out.push('  ' + t.dim(l));
    blank();
  };
  const n = (x: number): string => groupThousands(x, opts.lang === 'ru' ? ' ' : ',');
  return { W, bw, t, out, blank, body, note, section, n };
}

type Matrix = Record<string, Record<string, number>>;

function matrix(k: Kit, rowHeader: string, colPrefix: string, totalLabel: string, rows: string[], cols: readonly string[], m: Matrix, hot: (row: string, col: string) => boolean): void {
  const labelW = Math.max(visWidth(rowHeader), ...rows.map((r) => r.length)) + 1;
  const cellW = Math.max(7, visWidth(totalLabel) + 1);
  k.body(k.t.dim(padR(rowHeader, labelW)) + cols.map((c) => k.t.dim(padL(colPrefix + ' ' + c, cellW + 3))).join('') + k.t.dim(padL(totalLabel, cellW)));
  for (const r of rows) {
    const total = cols.reduce((a, c) => a + (m[r]?.[c] ?? 0), 0);
    const cells = cols.map((c) => {
      const v = m[r]?.[c] ?? 0;
      const text = padL(v === 0 ? '·' : k.n(v), cellW + 3);
      return v > 0 && hot(r, c) ? k.t.accent(text) : v === 0 ? k.t.dim(text) : k.t.num(text);
    });
    k.body(k.t.num(padR(r, labelW)) + cells.join('') + k.t.dim(padL(k.n(total), cellW)));
  }
}

function reasonRows(k: Kit, D: ReturnType<typeof replayStrings>, by: Partial<Record<SkipReason, number>>): void {
  const rows = SKIP_REASONS.filter((r) => (by[r] ?? 0) > 0);
  const numW = Math.max(1, ...rows.map((r) => k.n(by[r] ?? 0).length));
  for (const r of rows) k.body(k.t.dim('  ') + padL(k.t.num(k.n(by[r] ?? 0)), numW) + '  ' + k.t.dim(D.reasons[r]));
}

const SORTED_IDS = ['haiku-low', 'haiku-medium', 'haiku-high', 'sonnet-low', 'sonnet-medium', 'sonnet-high', 'opus-low', 'opus-medium', 'opus-high'];

// --select and --dry-run: what would be replayed. Runs nothing.
export function renderPlan(o: {
  mode: 'select' | 'dry-run';
  totalTasks: number;
  selectedTotal: number; // replayable before --max-tasks
  candidates: readonly Candidate[]; // after --max-tasks
  skippedByReason: Partial<Record<SkipReason, number>>;
  dirty: number;
  plan?: Plan;
  judgeDiff: boolean;
  dailyNote?: boolean;
}, opts: ReplayRenderOptions): string {
  const k = kit(opts);
  const { t, body, note, section, blank, n } = k;
  const D = replayStrings(opts.lang);
  k.out.push('  ' + t.accent('◆') + ' ' + t.bold(D.title) + t.dim(' · ' + (o.mode === 'select' ? D.selectTitle : D.dryTitle)));

  section(D.selTitle, D.selHint);
  const skippedTotal = Object.values(o.skippedByReason).reduce((a, b) => a + (b ?? 0), 0);
  body(t.dim(padR(D.selectedLabel, 24)) + padL(t.good(n(o.selectedTotal)), 7) + t.dim(` / ${n(o.totalTasks)}`));
  body(t.dim(padR(D.skippedLabel, 24)) + padL(t.num(n(skippedTotal)), 7));
  reasonRows(k, D, o.skippedByReason);
  if (o.dirty > 0) {
    blank();
    note(D.dirtyNote(n(o.dirty)));
  }
  if (o.candidates.length === 0) {
    blank();
    note(D.noCandidates);
    return k.out.join('\n');
  }

  section(D.candidatesTitle, '');
  for (const c of o.candidates.slice(0, 10)) {
    body(D.candidateRow(t.num(truncateStart(c.project, 34)), c.testCommand ? t.good(c.testCommand.command) : t.dim('—'), c.originalEdited ? t.num('edits') : t.dim('read-only')));
  }
  if (o.candidates.length > 10) body(t.dim(D.moreCandidates(n(o.candidates.length - 10))));

  if (o.plan) {
    const p = o.plan;
    section(D.planTitle, D.planHint);
    body(t.num(D.planShape(n(p.tasks), p.ladder.map((c) => c.replace('-', '·')).join(' → '), n(p.samples), n(p.maxRuns))));
    body(t.dim(D.planChecks(n(p.withTests), n(p.originalEdited), n(p.tasks))));
    blank();
    const ids = p.ladder;
    const labelW = Math.max(...ids.map((c) => c.length)) + 1;
    for (const id of ids) body(t.dim(padR(id.replace('-', '·'), labelW)) + padL(t.num(money(p.perConfigUsd[id] ?? 0)), 9));
    blank();
    body(t.accent(D.planCost(money(p.lowUsd), money(p.highUsd))));
    body(t.dim(D.planBudget(money(p.budgetUsd))));
    if (p.exceedsBudget) note(D.planExceeds);
    body(p.account === 'api-key' ? t.accent(D.accounts[p.account]) : t.dim(D.accounts[p.account]));
    if (p.dailyCap !== undefined) body(t.dim(D.planDaily(n(p.dailyCap))));
    if (!o.judgeDiff) note(D.noJudgeDiffNote);
  }
  return k.out.join('\n');
}

export function renderConfirm(plan: Plan, opts: ReplayRenderOptions): string {
  const k = kit(opts);
  const D = replayStrings(opts.lang);
  k.out.push('  ' + k.t.accent('◆') + ' ' + k.t.bold(D.confirmTitle));
  k.body(k.t.num(D.planShape(k.n(plan.tasks), plan.ladder.map((c) => c.replace('-', '·')).join(' → '), k.n(plan.samples), k.n(plan.maxRuns))));
  k.body(k.t.accent(D.planCost(money(plan.lowUsd), money(plan.highUsd))));
  k.body(k.t.dim(D.planBudget(money(plan.budgetUsd))));
  k.body(plan.account === 'api-key' ? k.t.accent(D.accounts[plan.account]) : k.t.dim(D.accounts[plan.account]));
  return k.out.join('\n');
}

export function renderReplaySummary(s: ReplaySummary, opts: ReplayRenderOptions, files: { runs: string; labels: string }): string {
  const k = kit(opts);
  const { t, body, note, section, blank, n, out, bw } = k;
  const D = replayStrings(opts.lang);

  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold(D.title), t.dim(localStamp(s.generatedAt)), k.W - 4));
  body(t.dim(D.headerLabeled(n(s.labeledTotal), n(s.tasks))));

  // ───────── this run ─────────
  section(D.runTitle, D.runHint);
  {
    const rows: Array<[string, number, (x: string) => string]> = [
      [D.selectedLabel, s.selected, t.num],
      [D.replayedLabel, s.replayed, t.num],
      [D.labeledLabel, s.labeledNow, t.good],
      [D.inconclusiveLabel, s.inconclusive, s.inconclusive > 0 ? t.bad : t.dim],
      [D.skippedRunLabel, s.skippedTotal, t.dim],
    ];
    const labelW = Math.max(...rows.map(([l]) => visWidth(l)));
    for (const [label, v, style] of rows) body(t.dim(padR(label, labelW)) + ' ' + padL(style(n(v)), 7));
    reasonRows(k, D, s.skipped);
    blank();
    body(t.num(D.runsLine(n(s.runs.count), n(s.runs.passed))));
    const judge = s.runs.judgeUsd > 0 ? ` + ${money(s.runs.judgeUsd)}` : '';
    body(t.accent(D.spent(money(s.runs.costUsd), judge, money(s.budgetUsd))));
    if (s.stopped) {
      blank();
      for (const l of wrap(D.stopped(s.stopped), bw)) body(t.bad(l));
    }
  }

  if (s.labeledTotal === 0) return out.join('\n');

  // ───────── L2 distribution ─────────
  section(D.distTitle, D.distHint);
  {
    const ids = SORTED_IDS.filter((id) => (s.ladder[id] ?? 0) > 0);
    const top = Math.max(...ids.map((id) => s.ladder[id] ?? 0), 1);
    const labelW = Math.max(...ids.map((c) => c.length)) + 1;
    const barW = Math.max(8, bw - labelW - 6 - 4 - 3);
    for (const id of ids) {
      const v = s.ladder[id] ?? 0;
      const b = bar(v / top, barW);
      const style = id.startsWith('opus') ? t.accent : id.startsWith('haiku') ? t.family('haiku-4.5') : t.sand;
      body(padR(t.num(id.replace('-', '·')), labelW) + style(b) + ' '.repeat(Math.max(0, barW - visWidth(b))) + ' ' + padL(t.num(n(v)), 6) + ' ' + padL(t.dim(pct(v / s.labeledTotal)), 4));
    }
    if (s.fallback > 0) {
      blank();
      note(D.fallbackNote(n(s.fallback), pct(s.fallback / s.labeledTotal)));
    }
  }

  // ───────── observed vs L2 ─────────
  section(D.obsTitle, D.obsHint);
  {
    const rows = OBSERVED_TIERS.filter((o) => L0_TIERS.some((c) => s.observedVsL2[o][c] > 0));
    matrix(k, D.obsRow, D.l2Col, D.colTotal, rows, L0_TIERS, s.observedVsL2, (r, c) => (r === 'opus' || r === 'fable') && c !== 'opus');
    const over = (['opus', 'fable'] as const).reduce((a, r) => a + s.observedVsL2[r].haiku + s.observedVsL2[r].sonnet, 0);
    blank();
    body(t.accent(D.overSpec(n(over), pct(over / s.labeledTotal))));
  }

  // ───────── L1 vs L2 ─────────
  section(D.l1Title, D.l1Hint);
  if (!s.l1) note(D.l1None);
  else if (s.l1.compared === 0) note(D.l1TooFew);
  else {
    const l = s.l1;
    body(t.dim(D.l1Compared(n(l.compared), tildify(l.file), String(l.threshold))));
    blank();
    matrix(k, D.l1Row, D.l2Col, D.colTotal, [...L0_TIERS], L0_TIERS, l.matrix, (r, c) => L0_TIERS.indexOf(c as (typeof L0_TIERS)[number]) > L0_TIERS.indexOf(r as (typeof L0_TIERS)[number]));
    blank();
    body(t.num(D.l1Exact(pct(l.exact / l.compared), pct(l.sameTier / l.compared))));
    body(l.l1Cheaper > 0 ? t.accent(D.l1Under(n(l.l1Cheaper), pct(l.l1Cheaper / l.compared))) : t.num(D.l1Under(n(0), pct(0))));
    body(t.num(D.l1Over(n(l.l1Dearer), pct(l.l1Dearer / l.compared))));
  }

  blank();
  body(t.dim(D.written + ': ') + t.num(truncateStart(tildify(files.runs), bw - visWidth(D.written) - 2)));
  body(t.dim('        ') + t.num(truncateStart(tildify(files.labels), bw - visWidth(D.written) - 2)));
  body(t.dim(D.runtime(formatDuration(s.durationMs))));
  blank();
  note(D.goldNote);
  note(D.weakCheckNote);
  note(D.nextNote);
  return out.join('\n');
}
