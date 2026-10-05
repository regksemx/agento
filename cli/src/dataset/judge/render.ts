// Terminal output of `dataset judge`, in the visual language of the audit and `dataset build`. Pure: data in, string out.

import { bar, clamp, groupThousands, localStamp, money, padL, padR, pct, spread, tildify, tokens, truncateStart, visWidth, wrap } from '../../report/format.ts';
import type { Lang } from '../../report/i18n.ts';
import { makeTheme, type ColorMode, type Theme } from '../../report/theme.ts';
import { formatDuration } from '../render.ts';
import { L0_TIERS, OBSERVED_TIERS } from '../summary.ts';
import type { Estimate } from './estimate.ts';
import { judgeStrings } from './i18n.ts';
import type { JudgeSummary } from './summary.ts';
import { JUDGE_CONFIGS } from './types.ts';

export interface JudgeRenderOptions {
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

function kit(opts: JudgeRenderOptions): Kit {
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

// Rows x tier columns; cells strictly "above" the diagonal for the over-spend reading are accented by `hot`.
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

export function renderJudgeSummary(s: JudgeSummary, opts: JudgeRenderOptions): string {
  const k = kit(opts);
  const { t, body, note, section, blank, n, out, bw } = k;
  const D = judgeStrings(opts.lang);

  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold(D.title), t.dim(localStamp(s.generatedAt)), k.W - 4));
  body(t.dim(D.headerTasks(n(s.judged), n(s.tasks))));
  body(t.dim(D.judgeLine(s.backend, s.model, s.promptVersion, String(s.threshold))));

  if (s.tasks === 0) {
    blank();
    note(D.noTasks);
    return out.join('\n');
  }

  // ───────── this run ─────────
  section(D.runTitle, D.runHint);
  {
    const r = s.run;
    const rows: Array<[string, number, (x: string) => string]> = [
      [D.judgedLabel, r.judged, t.good],
      [D.skippedLabel, r.skipped, t.dim],
      [D.failedLabel, r.failed, r.failed > 0 ? t.bad : t.dim],
    ];
    const labelW = Math.max(...rows.map(([l]) => visWidth(l)));
    for (const [label, v, style] of rows) body(t.dim(padR(label, labelW)) + ' ' + padL(style(n(v)), 7));
    if (r.failed > 0) body(t.dim(D.failedDetail(n(r.parseFailures), n(r.transportFailures))));
    if (r.usage.inputTokens + r.usage.outputTokens > 0) body(t.dim(D.usage(tokens(r.usage.inputTokens), tokens(r.usage.outputTokens))));
    if (r.usage.costUsd > 0) body(t.dim(D.usageCost(money(r.usage.costUsd))));
    if (r.aborted) {
      blank();
      for (const l of wrap(D.aborted(r.aborted), bw)) body(t.bad(l));
    }
    if (r.staleVersion > 0) {
      blank();
      note(D.staleWarn(n(r.staleVersion)));
    }
  }

  if (s.judged === 0) return out.join('\n');

  // ───────── L1 distribution ─────────
  section(D.distTitle, D.distHint);
  {
    const top = Math.max(...JUDGE_CONFIGS.map((c) => s.ladder[c.id]), 1);
    const labelW = Math.max(...JUDGE_CONFIGS.map((c) => c.id.length)) + 1;
    const barW = Math.max(8, bw - labelW - 6 - 4 - 3);
    for (const c of JUDGE_CONFIGS) {
      const v = s.ladder[c.id];
      const b = bar(v / top, barW);
      const style = c.tier === 'opus' ? t.accent : c.tier === 'haiku' ? t.family('haiku-4.5') : t.sand;
      body(padR(t.num(c.id.replace('-', '·')), labelW) + style(b) + ' '.repeat(Math.max(0, barW - visWidth(b))) + ' ' + padL(t.num(n(v)), 6) + ' ' + padL(t.dim(pct(v / s.judged)), 4));
    }
    blank();
    body(t.num(D.planFirst(n(s.needsPlanFirst), pct(s.needsPlanFirst / s.judged))));
    body(t.num(D.delegate(n(s.delegateExplore), pct(s.delegateExplore / s.judged))));
    body(t.dim(D.meanDifficulty(s.meanDifficulty.toFixed(1))));
  }

  // ───────── L0 vs L1 ─────────
  section(D.l0Title, D.l0Hint);
  {
    // above the diagonal: the judge asks for a stronger tier than L0
    const rank = (x: string): number => L0_TIERS.indexOf(x as (typeof L0_TIERS)[number]);
    matrix(k, D.l0Row, D.l1Col, D.colTotal, [...L0_TIERS], L0_TIERS, s.l0VsL1, (r, c) => rank(c) > rank(r));
    blank();
    body(t.num(D.agree(pct(s.agreement))));
  }

  // ───────── history vs L1 ─────────
  section(D.histTitle, D.histHint);
  {
    const rows = OBSERVED_TIERS.filter((o) => L0_TIERS.some((c) => s.observedVsL1[o][c] > 0));
    matrix(k, D.histRow, D.l1Col, D.colTotal, rows, L0_TIERS, s.observedVsL1, (r, c) => (r === 'opus' || r === 'fable') && c !== 'opus');
    blank();
    const o = s.overSpec;
    for (const [i, l] of wrap(D.overSpec(n(o.count), pct(o.share), money(o.cost), money(o.saving)), bw).entries()) body(i === 0 ? t.accent(l) : l);
  }

  // ───────── output ─────────
  blank();
  body(t.dim(D.written + ': ') + t.num(truncateStart(tildify(s.out), bw - visWidth(D.written) - 2)));
  body(t.dim(D.runtime(formatDuration(s.run.durationMs))));
  blank();
  note(D.unvalidatedNote);
  note(D.nextNote);
  return out.join('\n');
}

export function renderDryRun(e: Estimate, out: string, opts: JudgeRenderOptions, extra: { claudeWithoutMax?: boolean } = {}): string {
  const k = kit(opts);
  const { t, body, note, blank, n } = k;
  const D = judgeStrings(opts.lang);
  k.out.push('  ' + t.accent('◆') + ' ' + t.bold(D.title) + t.dim(' · ' + D.dryTitle));
  body(t.dim(`${e.backend} · ${e.model}`));
  blank();
  body(t.num(D.dryTasks(n(e.tasks), n(e.totalTasks), n(e.judgedAlready))));
  if (e.tasks === 0) {
    blank();
    note(D.dryNothing);
    return k.out.join('\n');
  }
  body(t.dim(D.dryTokens(tokens(e.inputTokens), tokens(e.outputTokens), tokens(e.systemTokens))));
  blank();
  if (e.backend === 'claude') {
    body(e.costUsd !== undefined ? t.accent(D.dryCost(money(e.costUsd), e.model)) : t.dim(D.dryCostUnknown(e.model)));
    note(D.drySubscription);
    if (extra.claudeWithoutMax) note(D.dryNoMax);
  } else {
    body(t.dim(D.dryOwnGpu));
  }
  blank();
  body(t.dim(D.dryFile + ': ') + t.num(truncateStart(tildify(out), k.bw - visWidth(D.dryFile) - 2)));
  return k.out.join('\n');
}

export function renderConfirm(e: Estimate, opts: JudgeRenderOptions): string {
  const k = kit(opts);
  const D = judgeStrings(opts.lang);
  k.out.push('  ' + k.t.accent('◆') + ' ' + k.t.bold(D.confirmTitle));
  k.body(k.t.num(D.dryTasks(k.n(e.tasks), k.n(e.totalTasks), k.n(e.judgedAlready))));
  k.body(k.t.dim(D.dryTokens(tokens(e.inputTokens), tokens(e.outputTokens), tokens(e.systemTokens))));
  k.body(e.costUsd !== undefined ? k.t.accent(D.dryCost(money(e.costUsd), e.model)) : k.t.dim(D.dryCostUnknown(e.model)));
  k.note(D.drySubscription);
  return k.out.join('\n');
}
