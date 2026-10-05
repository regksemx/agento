// The card and the report of `dataset label`, in the visual language of the audit (◆, accent, dim, boxes). Pure: data in, string out.

import { bar, clamp, localStamp, money, padL, padR, pct, shortModel, spread, tildify, truncateStart, visWidth, wrap } from '../../report/format.ts';
import type { Lang } from '../../report/i18n.ts';
import { makeTheme, type ColorMode } from '../../report/theme.ts';
import { kit, matrix } from '../judge/render.ts';
import type { TaskRecord } from '../types.ts';
import { labelStrings } from './i18n.ts';
import type { HumanReport, SourceAgreement } from './metrics.ts';
import { STEPS, type Step } from './session.ts';
import type { Answers } from './store.ts';
import { TIERS, tierRank, type L1Guess } from './types.ts';

export interface RenderOptions {
  color: ColorMode;
  width: number;
  lang: Lang;
}

export const PROMPT_LINES = 12;

export interface CardView {
  task: TaskRecord;
  l1?: L1Guess;
  index: number; // 0-based
  total: number;
  saved: number;
  step: Step;
  answers: Partial<Answers>;
  cursor: number | null;
  expanded: boolean;
  guesses: boolean;
  maxExpandedLines?: number; // cap of the expanded prompt, so the card fits the terminal (default 60)
}

export function formatDurationHuman(ms: number, lang: Lang): string {
  const D = labelStrings(lang);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return D.durationSec(s);
  const m = Math.round(s / 60);
  return m < 60 ? D.durationMin(m) : D.durationHourMin(Math.floor(m / 60), m % 60);
}

// The scrubbed prompt as display lines: its own line breaks are kept, long lines wrapped, runs of blank lines collapsed.
export function promptLines(text: string, width: number): string[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? c : ' '));
  const out: string[] = [];
  for (const raw of clean.split('\n')) {
    if (raw.trim() === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(...wrap(raw.trim(), width));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length > 0 ? out : [''];
}

export function renderCard(v: CardView, opts: RenderOptions): string {
  const W = clamp(Number.isFinite(opts.width) ? Math.floor(opts.width) : 80, 64, 100);
  const t = makeTheme(opts.color);
  const D = labelStrings(opts.lang);
  const o = v.task.observed;
  const out: string[] = [];
  const blank = (): void => void out.push('');
  const body = (x: string): void => void out.push('    ' + x);
  const bw = W - 6;

  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold(D.title), t.dim(D.progress(v.index + 1, v.total, v.saved)), W - 4));
  const when = localStamp(new Date(v.task.startTs).toISOString());
  const followUps = Math.max(0, v.task.text.length - 1);
  body(t.dim(truncateStart(tildify(v.task.project), Math.max(12, bw - 40)) + ' · ' + when + ' · ' + D.followUps(followUps)));
  blank();

  // ───────── the prompt, boxed ─────────
  {
    const boxW = W - 4;
    const cw = boxW - 4;
    const border = t.accent;
    const row = (content: string): void => void out.push('  ' + border('│') + ' ' + padR(content, cw) + ' ' + border('│'));
    const titleText = ' ' + D.boxTitle + ' ';
    out.push('  ' + border('╭─') + t.accentBold(titleText) + border('─'.repeat(boxW - 3 - visWidth(titleText)) + '╮'));
    const lines = promptLines(v.task.text[0] ?? '', cw);
    const cap = v.expanded ? Math.max(PROMPT_LINES, v.maxExpandedLines ?? 60) : PROMPT_LINES;
    const shown = lines.slice(0, cap);
    for (const l of shown) row(l);
    const hidden = lines.length - shown.length;
    if (hidden > 0) row(t.dim(D.moreLines(hidden) + ' (' + D.expandHint + ')'));
    out.push('  ' + border('╰' + '─'.repeat(boxW - 2) + '╯'));
  }
  blank();

  // ───────── what happened ─────────
  {
    const kv = (label: string, n: number, hot = false): string => t.dim(label + ' ') + (hot && n > 0 ? t.accent(String(n)) : t.num(String(n)));
    const sep = t.dim(' · ');
    const effort = o.effort ? shortEffort(o.effort) : undefined;
    const head = t.num(shortModel(o.model) + (effort ? '·' + effort : '')) + (effort ? '' : ' ' + t.dim(D.noEffort));
    const l1 = [head, kv(D.steps, o.mainCalls), kv(D.files, o.filesEdited), kv(D.lines, o.linesChanged)];
    if (o.subagentCalls > 0) l1.push(kv(D.subagents, o.subagentCalls));
    const l2 = [kv(D.errors, o.toolErrors, true), kv(D.testFailures, o.testFailures, true), kv(D.corrections, o.userCorrections, true)];
    if (o.planMode) l2.push(t.num(D.planMode));
    const l3 = [t.num(formatDurationHuman(o.durationMs, opts.lang)), t.num(D.costApi(money(o.cost)))];
    body(t.accentBold(D.factsTitle));
    body(l1.join(sep));
    body(l2.join(sep));
    body(l3.join(sep));
  }
  blank();

  // ───────── guesses: hidden by default, so they do not anchor the answer ─────────
  if (!v.guesses) body(t.dim(D.guessesHidden));
  else {
    const g = (label: string, tier: string, effort: string): string => label + ' ' + tier + '·' + effort;
    const parts = [
      g('L0', v.task.l0Tier, v.task.l0Effort),
      g(D.guessRules, v.task.rulesVerdict.tier, v.task.rulesVerdict.effort),
      v.l1 ? g('L1', v.l1.tier, v.l1.effort) : 'L1 ' + D.guessNone,
    ];
    body(t.dim(D.guessesLabel + ': ' + parts.join(' · ')));
  }
  blank();

  // ───────── the question ─────────
  {
    const left = '  ' + t.accentBold(D.step(STEPS.indexOf(v.step) + 1, STEPS.length)) + ' ';
    out.push(left + t.dim('─'.repeat(Math.max(2, W - 2 - visWidth(left)))));
    const q = { tier: D.qTier, effort: D.qEffort, plan: D.qPlan, delegate: D.qDelegate }[v.step];
    for (const l of wrap(q, bw)) body(t.bold(l));
    const opt = (key: string, label: string, i: number | null): string => {
      const on = i !== null && v.cursor === i;
      return (on ? t.accent('▸') : ' ') + t.accentBold('[' + key + ']') + ' ' + (on ? t.bold(label) : label);
    };
    let main: string[];
    if (v.step === 'tier') main = TIERS.map((x, i) => opt(String(i + 1), x, i));
    else if (v.step === 'effort') main = (['low', 'medium', 'high'] as const).map((x, i) => opt(String(i + 1), x, i));
    else main = [opt('y', D.yes, 0), opt('n', D.no, 1)];
    const extra = [opt('s', D.optSkip, null), opt('?', D.optUnsure, null)];
    const oneRow = main.join(' ') + '   ' + extra.join(' ');
    if (visWidth(oneRow) <= bw) body(oneRow);
    else {
      body(main.join(' '));
      body(extra.join(' '));
    }
    const done: string[] = [];
    if (v.answers.tier) done.push(D.tierWord + ' ' + v.answers.tier);
    if (v.answers.effort) done.push(D.effortWord + ' ' + v.answers.effort);
    if (v.answers.plan !== undefined) done.push(D.planWord + ' ' + (v.answers.plan ? D.yes : D.no));
    if (v.answers.delegate !== undefined) done.push(D.delegateWord + ' ' + (v.answers.delegate ? D.yes : D.no));
    if (done.length > 0) body(t.dim(D.answered + ': ') + t.num(done.join(' · ')));
    blank();
    const keys = v.expanded ? D.keysExpanded : v.guesses ? D.keysGuesses : D.keys;
    for (const l of wrap(keys, bw)) body(t.dim(l));
    body(t.dim(D.keysArrows));
  }
  return out.join('\n');
}

function shortEffort(e: string): string {
  return e === 'xhigh' ? 'xhigh' : e;
}

// ───────── the report ─────────

export interface ReportExtras {
  generatedAt: string;
  path: string;
  sessionSaved?: number;
}

export function renderLabelReport(r: HumanReport, x: ReportExtras, opts: RenderOptions): string {
  const k = kit(opts);
  const { t, body, note, section, blank, n, out, bw } = k;
  const D = labelStrings(opts.lang);

  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold(D.reportTitle), t.dim(localStamp(x.generatedAt)), k.W - 4));
  body(t.dim(D.reportHeader(n(r.labeled), n(r.unsure), n(r.tasksTotal))));
  if (x.sessionSaved !== undefined) body(t.dim(D.savedNow(n(x.sessionSaved))));

  if (r.labeled === 0) {
    blank();
    note(D.noLabels);
    return out.join('\n');
  }

  // ───────── distribution ─────────
  section(D.distTitle, D.distHint);
  {
    const top = Math.max(...TIERS.map((c) => r.tier[c]), 1);
    const barW = Math.max(8, bw - 6 - 7 - 6 - 3);
    for (const c of TIERS) {
      const v = r.tier[c];
      const b = bar(v / top, barW);
      const style = c === 'opus' ? t.accent : c === 'haiku' ? t.family('haiku-4.5') : t.sand;
      body(padR(t.num(c), 7) + style(b) + ' '.repeat(Math.max(0, barW - visWidth(b))) + ' ' + padL(t.num(n(v)), 6) + ' ' + padL(t.dim(pct(v / r.labeled)), 4));
    }
    blank();
    const eff = (['low', 'medium', 'high'] as const).map((e) => `${e} ${t.num(n(r.effort[e]))}`);
    body(t.dim(D.effortLabel + ': ') + eff.join(t.dim(' · ')));
    body(t.num(D.planYes(n(r.planYes), pct(r.planYes / r.labeled))));
    body(t.num(D.delegateYes(n(r.delegateYes), pct(r.delegateYes / r.labeled))));
    body(t.dim(D.meanTime(formatDurationHuman(r.meanSeconds * 1000, opts.lang))));
  }

  // ───────── agreement ─────────
  section(D.agreeTitle, D.agreeHint);
  {
    const live = r.sources.filter((s) => s.n > 0);
    const labelW = Math.max(visWidth(D.colSource), ...live.map((s) => visWidth(D.src[s.id])));
    const w = { n: Math.max(5, visWidth(D.colN)), c: 7 };
    body(
      t.dim(padR(D.colSource, labelW)) + t.dim(padL(D.colN, w.n + 2)) + t.dim(padL(D.colTier, w.c + 1)) + t.dim(padL(D.colUnder, w.c + 1)) + t.dim(padL(D.colOver, w.c + 1)) + t.dim(padL(D.colEffort, w.c + 2)),
    );
    for (const s of live) {
      const share = (v: number, d: number): string => (d > 0 ? pct(v / d) : '–');
      body(
        padR(t.num(D.src[s.id]), labelW) +
          padL(t.dim(n(s.n)), w.n + 2) +
          padL(t.num(share(s.tierHit, s.n)), w.c + 1) +
          padL(s.under > 0 ? t.accent(share(s.under, s.n)) : t.dim(share(s.under, s.n)), w.c + 1) +
          padL(s.over > 0 ? t.sand(share(s.over, s.n)) : t.dim(share(s.over, s.n)), w.c + 1) +
          padL(t.num(share(s.effortHit, s.effortN)), w.c + 2),
      );
    }
    const l1 = r.sources.find((s) => s.id === 'l1')!;
    blank();
    if (l1.n === 0) note(D.noL1);
    else {
      for (const l of wrap(D.l1Verdict(pct(l1.under / l1.n), pct(l1.over / l1.n)), bw)) body(l1.under > 0 ? t.accent(l) : l);
      const f = r.l1Flags;
      if (f.planN > 0 || f.delegateN > 0) body(t.dim(D.l1Flags(f.planN > 0 ? pct(f.planHit / f.planN) : '–', f.delegateN > 0 ? pct(f.delegateHit / f.delegateN) : '–')));
    }
    if (r.labeled < 30) {
      blank();
      note(D.smallSample(r.labeled));
    }
  }

  // ───────── confusion ─────────
  const confusion = (title: string, s: SourceAgreement): void => {
    section(title, D.confHint);
    matrix(k, D.rowHuman, D.colGuess, D.colTotal, [...TIERS], TIERS, s.confusion, (row, col) => tierRank(col as (typeof TIERS)[number]) < tierRank(row as (typeof TIERS)[number]));
  };
  const l1 = r.sources.find((s) => s.id === 'l1')!;
  if (l1.n > 0) confusion(D.confL1Title, l1);
  confusion(D.confL0Title, r.sources.find((s) => s.id === 'l0')!);

  blank();
  body(t.dim(D.fileLabel + ': ') + t.num(truncateStart(tildify(x.path), bw - visWidth(D.fileLabel) - 2)));
  blank();
  note(D.goldNote);
  return out.join('\n');
}
