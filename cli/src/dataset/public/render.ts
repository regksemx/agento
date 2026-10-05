// Terminal output of `dataset import` and `dataset validate-judge`, in the audit's visual language. Pure: data in, string out.

import { bar, localStamp, padL, padR, pct, spread, tildify, truncateStart, visWidth, wrap } from '../../report/format.ts';
import { formatDuration } from '../render.ts';
import { kit, matrix, type JudgeRenderOptions } from '../judge/render.ts';
import { TIERS, type ImportSummary } from './import.ts';
import { publicStrings } from './i18n.ts';
import type { Agreement, Reliability, ValidationSummary } from './validate.ts';
import { PUBLIC_TIERS } from './tier.ts';

const f2 = (x: number): string => x.toFixed(2);

export function renderImportSummary(s: ImportSummary, opts: JudgeRenderOptions): string {
  const k = kit(opts);
  const { t, body, note, section, blank, n, out, bw } = k;
  const D = publicStrings(opts.lang);

  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold(D.importTitle), t.dim(localStamp(s.generatedAt)), k.W - 4));
  body(t.dim(D.importHeader(n(s.records), n(s.trajectories))));
  body(t.dim(D.sourceLine(s.source.kind, truncateStart(tildify(s.source.input), bw - 14))));
  if (s.source.commit || s.source.license) body(t.dim(D.commitLine((s.source.commit ?? '–').slice(0, 10), s.source.license ?? '–')));
  if (s.records === 0) {
    blank();
    note(D.noRecords);
    return out.join('\n');
  }

  section(D.workloadTitle, D.workloadHint);
  const rows = Object.keys(s.byBenchmark).sort();
  matrix(k, D.workloadRow, '', D.colTotal, rows, TIERS, s.byBenchmark, (_r, c) => c === 'opus');
  blank();
  const top = Math.max(...TIERS.map((x) => s.tier[x]), 1);
  const barW = Math.max(8, bw - 7 - 6 - 4 - 3);
  for (const x of TIERS) {
    const b = bar(s.tier[x] / top, barW);
    const style = x === 'opus' ? t.accent : x === 'haiku' ? t.family('haiku-4.5') : t.sand;
    body(padR(t.num(x), 7) + style(b) + ' '.repeat(Math.max(0, barW - visWidth(b))) + ' ' + padL(t.num(n(s.tier[x])), 6) + ' ' + padL(t.dim(pct(s.tier[x] / s.records)), 4));
  }

  section(D.tiersTitle, D.tiersHint);
  body(t.num(D.publicTierLine(PUBLIC_TIERS.map((p) => n(s.publicTier[p])).join(' / '))));
  body(t.dim(D.stageLine(Object.entries(s.pipelineStage).map(([k2, v]) => `${k2} ${n(v)}`).join(' · '))));
  body(t.dim(D.prefixLine(n(s.prefixChars.mean), n(s.prefixChars.median), n(s.prefixChars.max), n(s.truncated), n(s.textLimit))));
  if (s.skipped.total > 0) {
    const parts = Object.entries(s.skipped.reasons).filter(([, v]) => v > 0).map(([r, v]) => `${r} ${v}`).join(', ');
    body(t.accent(D.skippedLine(n(s.skipped.total), parts)));
  }

  blank();
  body(t.dim(D.written + ': ') + t.num(truncateStart(tildify(s.out), bw - visWidth(D.written) - 2)));
  body(t.dim(D.noticeLabel + ': ') + t.dim(s.source.license ?? 'Apache-2.0') + t.dim(' · ') + t.dim(D.runtime(formatDuration(s.durationMs))));
  blank();
  note(D.stepNote);
  note(D.nextNote);
  return out.join('\n');
}

function reliabilityTable(k: ReturnType<typeof kit>, r: Reliability, D: ReturnType<typeof publicStrings>): void {
  const { t, body, n, bw } = k;
  const c = D.relCols;
  const binW = 9;
  const numW = 7;
  const barW = Math.max(8, Math.min(24, bw - binW - numW * 3 - 6));
  body(t.dim(padR(c.bin, binW) + padL(c.n, numW) + padL(c.meanP, numW + 2) + padL(c.observed, numW + 2)));
  for (const b of r.bins) {
    const label = `${f2(b.lo)}-${f2(b.hi)}`;
    if (b.n === 0) {
      body(t.dim(padR(label, binW) + padL('·', numW)));
      continue;
    }
    const gap = Math.abs(b.observed - b.meanP);
    const style = gap > 0.2 ? t.bad : gap > 0.1 ? t.accent : t.good;
    const bb = bar(b.observed, barW);
    body(t.num(padR(label, binW)) + padL(t.num(n(b.n)), numW) + padL(t.dim(f2(b.meanP)), numW + 2) + padL(style(f2(b.observed)), numW + 2) + ' ' + style(bb));
  }
}

const rate = (x: number): string => pct(x);

export function renderValidation(s: ValidationSummary, opts: JudgeRenderOptions): string {
  const k = kit(opts);
  const { t, body, note, section, blank, n, out, bw } = k;
  const D = publicStrings(opts.lang);

  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold(D.valTitle), t.dim(localStamp(s.generatedAt)), k.W - 4));
  body(t.dim(D.valHeader(n(s.compared), n(s.labelled))));
  body(t.dim(D.valJudgeLine(s.judgeModels.join(', ') || '–', s.promptVersions.join(', ') || '–', String(s.threshold))));
  const fileLine = (label: string, p: string): void => body(t.dim(label + ': ') + t.dim(truncateStart(tildify(p), bw - visWidth(label) - 2)));
  fileLine(D.valJudgeFile, s.judgeFile);
  fileLine(D.valLabelsFile, s.labelsFile);
  if (s.compared === 0) {
    blank();
    note(D.valNone);
    return out.join('\n');
  }
  if (s.unmatchedVerdicts > 0) body(t.dim(D.valUnmatched(n(s.unmatchedVerdicts))));
  if (s.promptVersions.length > 1) body(t.accent(D.valMixedPrompts(String(s.promptVersions.length))));

  // ───────── agreement ─────────
  section(D.agreeTitle, D.agreeHint);
  {
    const m = s.main;
    const rows: Array<[string, number, number, (x: string) => string]> = [
      [D.accuracy, m.accuracy, m.exact, t.good],
      [D.underLabel, m.underRate, m.under, m.underRate > 0.05 ? t.bad : t.accent],
      [D.overLabel, m.overRate, m.over, t.sand],
    ];
    const labelW = Math.max(...rows.map(([l]) => visWidth(l))) + 1;
    const barW = Math.max(8, bw - labelW - 6 - 7 - 8 - 4);
    for (const [label, share, count, style] of rows) {
      const b = bar(share, barW);
      body(padR(t.dim(label), labelW) + style(b) + ' '.repeat(Math.max(0, barW - visWidth(b))) + ' ' + padL(t.num(rate(share)), 5) + ' ' + padL(t.dim(n(count)), 6));
    }
    blank();
    const maj = TIERS.reduce((a, x) => (s.verified[x] > s.verified[a] ? x : a), TIERS[0]!);
    body(t.dim(D.baselineLine(rate(s.majorityBaseline), maj)));
  }

  // ───────── confusion ─────────
  section(D.confTitle, D.confHint);
  matrix(k, D.confRow, D.confCol, D.colTotal, [...TIERS], TIERS, s.confusion, (r, c) => TIERS.indexOf(c as (typeof TIERS)[number]) < TIERS.indexOf(r as (typeof TIERS)[number]));

  // ───────── by workload ─────────
  if (s.byBenchmark.length > 1) {
    section(D.benchTitle, D.benchHint);
    const c = D.benchCols;
    const labelW = Math.max(...s.byBenchmark.map((b) => b.benchmark.length), 8) + 1;
    body(t.dim(padR('', labelW) + padL(c.n, 7) + padL(c.acc, 10) + padL(c.under, 8) + padL(c.over, 8)));
    for (const b of s.byBenchmark) {
      body(t.num(padR(b.benchmark, labelW)) + padL(t.num(n(b.n)), 7) + padL(t.good(rate(b.accuracy)), 10) + padL(b.underRate > 0.05 ? t.bad(rate(b.underRate)) : t.accent(rate(b.underRate)), 8) + padL(t.sand(rate(b.overRate)), 8));
    }
  }

  // ───────── calibration ─────────
  section(D.relTitle, D.relHint);
  reliabilityTable(k, s.sonnetSuffices, D);
  blank();
  body(t.num(D.relSummary(f2(s.sonnetSuffices.ece), f2(s.sonnetSuffices.brier), rate(s.sonnetSuffices.base))));
  body(t.dim(D.relHaiku(f2(s.haikuSuffices.ece), rate(s.haikuSuffices.base))));

  // ───────── sweep ─────────
  section(D.sweepTitle, D.sweepHint);
  {
    const c = D.sweepCols;
    body(t.dim(padR(c.thr, 7) + padL(c.acc, 10) + padL(c.under, 8) + padL(c.over, 8) + padL(c.saving, 10)));
    for (const r of s.sweep as Array<Agreement & { threshold: number; saving: number; recommended?: boolean }>) {
      const tag = [r.threshold === s.threshold ? D.sweepCurrent : '', r.recommended ? D.sweepRecommended : ''].filter(Boolean).join(', ');
      const under = r.underRate > s.maxUnder ? t.bad(rate(r.underRate)) : t.good(rate(r.underRate));
      body(t.num(padR(f2(r.threshold), 7)) + padL(t.num(rate(r.accuracy)), 10) + padL(under, 8) + padL(t.sand(rate(r.overRate)), 8) + padL(t.num(rate(r.saving)), 10) + (tag ? '  ' + t.accent('◆ ' + tag) : ''));
    }
    blank();
    for (const l of wrap(D.sweepOracle(rate(s.oracleSaving)), bw)) body(t.dim(l));
    const msg = s.recommended !== undefined ? D.recommendLine(f2(s.recommended), rate(s.maxUnder)) : D.recommendNone(rate(s.maxUnder));
    for (const l of wrap(msg, bw)) body(s.recommended !== undefined ? t.accent(l) : t.bad(l));
  }

  blank();
  note(D.caveatMapping);
  note(D.caveatStep);
  note(D.caveatBalance);
  return out.join('\n');
}
