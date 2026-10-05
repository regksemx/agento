// Terminal summary of `dataset build`, in the visual language of the audit report. Pure: summary in, string out.

import { bar, clamp, groupThousands, money, padL, padR, pct, spread, tildify, truncateStart, visWidth, wrap } from '../report/format.ts';
import { localStamp } from '../report/format.ts';
import { strings, type Lang } from '../report/i18n.ts';
import { makeTheme, type ColorMode } from '../report/theme.ts';
import { datasetStrings } from './i18n.ts';
import { SCRUB_KINDS } from './scrub.ts';
import { L0_TIERS, OBSERVED_TIERS, type DatasetSummary } from './summary.ts';

export interface DatasetRenderOptions {
  color: ColorMode;
  width: number;
  lang: Lang;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function renderDatasetSummary(s: DatasetSummary, opts: DatasetRenderOptions): string {
  const W = clamp(Number.isFinite(opts.width) ? Math.floor(opts.width) : 80, 64, 100);
  const t = makeTheme(opts.color);
  const D = datasetStrings(opts.lang);
  const R = strings(opts.lang);
  const bw = W - 6;
  const out: string[] = [];
  const blank = (): void => void out.push('');
  const body = (x: string): void => void out.push('    ' + x);
  const n = (x: number): string => groupThousands(x, opts.lang === 'ru' ? ' ' : ',');
  const note = (text: string): void => {
    wrap(text, bw - 2).forEach((l, i) => body((i === 0 ? t.dim('⎿ ') : '  ') + t.dim(l)));
  };
  const section = (title: string, hint: string): void => {
    blank();
    const left = '  ' + t.accentBold(title) + ' ';
    out.push(left + t.dim('─'.repeat(Math.max(2, W - 2 - visWidth(left)))));
    if (!hint) return blank();
    for (const l of wrap(hint, W - 4)) out.push('  ' + t.dim(l));
    blank();
  };

  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold(D.title + ' build'), t.dim(localStamp(s.generatedAt)), W - 4));
  body(t.dim(D.header(`${n(s.tasks)} ${opts.lang === 'ru' ? 'задач' : 'tasks'}`, R.sessions(s.sessions), `${n(s.projects)} ${opts.lang === 'ru' ? 'проектов' : 'projects'}`)));
  body(t.dim(D.filter(s.filters.since, s.filters.project)));

  if (s.tasks === 0) {
    blank();
    note(D.noTasks);
    return out.join('\n');
  }

  // ───────── history vs L0 ─────────
  section(D.confusionTitle, D.confusionHint);
  {
    const rows = OBSERVED_TIERS.filter((o) => s.observedTier[o] > 0);
    const labelW = Math.max(visWidth(D.rowHeader), ...rows.map((r) => r.length)) + 1;
    const cellW = Math.max(7, visWidth(D.colTotal) + 1);
    body(t.dim(padR(D.rowHeader, labelW)) + L0_TIERS.map((c) => t.dim(padL('l0 ' + c, cellW + 3))).join('') + t.dim(padL(D.colTotal, cellW)));
    for (const o of rows) {
      const expensive = o === 'opus' || o === 'fable';
      const cells = L0_TIERS.map((c) => {
        const v = s.confusion[o][c];
        const text = padL(v === 0 ? '·' : n(v), cellW + 3);
        // the over-spend cells: opus/fable in history, L0 below opus
        return v > 0 && expensive && c !== 'opus' ? t.accent(text) : v === 0 ? t.dim(text) : t.num(text);
      });
      body(t.num(padR(o, labelW)) + cells.join('') + t.dim(padL(n(s.observedTier[o]), cellW)));
    }
    blank();
    const o = s.overSpec;
    const line = D.overSpec(n(o.count), pct(o.share), money(o.cost));
    for (const [i, l] of wrap(line, bw).entries()) body(i === 0 ? t.accent(l) : l);
  }

  // ───────── L0 distribution ─────────
  section(D.distTitle, D.distHint);
  {
    const total = s.tasks;
    const top = Math.max(...L0_TIERS.map((k) => s.l0Tier[k]), 1);
    const barW = Math.max(8, bw - 6 - 7 - 6 - 3);
    for (const k of L0_TIERS) {
      const v = s.l0Tier[k];
      const b = bar(v / top, barW);
      const style = k === 'opus' ? t.accent : k === 'haiku' ? t.family('haiku-4.5') : t.sand;
      body(padR(t.num(k), 7) + style(b) + ' '.repeat(Math.max(0, barW - visWidth(b))) + ' ' + padL(t.num(n(v)), 6) + ' ' + padL(t.dim(pct(v / total)), 4));
    }
    blank();
    const eff = (['low', 'medium', 'high'] as const).map((e) => `${e} ${t.num(n(s.l0Effort[e]))}`);
    body(t.dim(D.effortLabel + ': ') + eff.join(t.dim(' · ')));
  }

  // ───────── corrections ─────────
  section(D.correctionsTitle, '');
  body(t.num(D.corrections(n(s.withCorrections.count), pct(s.withCorrections.share))));
  body(t.dim(D.rulesAgree(pct(s.rulesAgreement))));

  // ───────── scrubbing ─────────
  section(D.scrubTitle, '');
  if (s.scrub.total === 0) body(t.dim(D.scrubNone));
  else {
    body(t.num(D.scrubTotal(n(s.scrub.total))));
    const kinds = SCRUB_KINDS.filter((k) => s.scrub.hits[k] > 0);
    const labelW = Math.max(...kinds.map((k) => visWidth(D.kind[k])));
    for (const k of kinds) body(t.dim(padR(D.kind[k], labelW)) + ' ' + padL(t.num(n(s.scrub.hits[k])), 7));
  }

  // ───────── output ─────────
  blank();
  const path = truncateStart(tildify(s.out), bw - visWidth(D.written) - 2);
  body(t.dim(D.written + ': ') + t.num(path));
  body(t.dim(D.runtime(formatDuration(s.durationMs))));
  blank();
  note(D.weakNote);
  note(D.nextNote);
  return out.join('\n');
}
