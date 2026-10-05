// Terminal renderer in the visual language of Claude Code. Pure: AuditReport in, string out.

import type { AuditReport, Confidence } from '../types.ts';
import {
  allocate,
  bar,
  bytes,
  clamp,
  downsample,
  localStamp,
  money,
  money3,
  padL,
  padR,
  pct,
  sanitizeInline,
  shortModel,
  sparkChar,
  spread,
  tildify,
  tokens,
  truncate,
  truncateStart,
  visWidth,
  wrap,
  wrapParts,
  wrapWith,
} from './format.ts';
import { dateShort, strings } from './i18n.ts';
import { makeTheme, type ColorMode } from './theme.ts';

export interface TerminalOptions {
  color: ColorMode;
  width: number;
}

const MONTH_DAYS = 30;

export function renderTerminal(r: AuditReport, opts: TerminalOptions): string {
  const W = clamp(Number.isFinite(opts.width) ? Math.floor(opts.width) : 80, 64, 100);
  const t = makeTheme(opts.color);
  const S = strings(r.meta.lang);
  const out: string[] = [];
  const bw = W - 6; // body width: indent 4, right margin 2
  const dt = (iso: string): string => dateShort(iso, S);

  const blank = (): void => void out.push('');
  const body = (s: string): void => void out.push('    ' + s);
  const tag = (kind: Confidence): string => t.dim(kind === 'fact' ? S.fact : S.estimate);
  const est = (usd: number): string => t.num(money(usd)) + ' ' + tag('estimate');
  const saving = (usd: number): string => t.good('−' + money(Math.abs(usd)));

  // Wrapped dim text; an optional styled tail (e.g. the estimate tag) stays on the last line if it fits.
  const flow = (text: string, tail: string, first: string, rest: string, width: number): void => {
    const lines = wrap(text, width);
    const tailW = visWidth(tail);
    lines.forEach((l, i) => {
      const fits = i === lines.length - 1 && tail && visWidth(l) + 1 + tailW <= width;
      body((i === 0 ? first : rest) + t.dim(l) + (fits ? ' ' + tail : ''));
    });
    if (tail && visWidth(lines[lines.length - 1]!) + 1 + tailW > width) body(rest + tail);
  };
  const note = (text: string, tail = ''): void => flow(text, tail, t.dim('⎿ '), '  ', bw - 2);
  const line = (text: string, tail = ''): void => flow(text, tail, '', '', bw);

  const section = (title: string, hint: string, right = ''): void => {
    blank();
    const left = '  ' + t.accentBold(title) + ' ';
    const rp = right ? ' ' + right : '';
    out.push(left + t.dim('─'.repeat(Math.max(2, W - 2 - visWidth(left) - visWidth(rp)))) + rp);
    for (const l of wrap(hint, W - 4)) out.push('  ' + t.dim(l));
    blank();
  };

  const kv = (label: string, value: string): void => body(spread(t.dim(label), value, bw));

  // ───────── header ─────────
  const stamp = localStamp(r.meta.generatedAt);
  out.push('  ' + spread(t.accent('◆') + ' ' + t.bold('agento audit'), t.dim(stamp), W - 4));
  const periodBits = [
    S.days(r.meta.days) + (r.meta.since && !/^\d+[dw]$|^all$/.test(r.meta.since) ? ` ${S.since(r.meta.since)}` : ''),
    S.sessions(r.meta.sessions),
    S.requests(r.meta.calls),
  ];
  for (const l of wrapParts(periodBits.map((x) => t.dim(x)), t.dim(' · '), bw)) body(l);
  const dir = truncateStart(r.meta.dir, Math.max(16, bw - visWidth(S.priceDate(r.meta.pricesAsOf)) - 3));
  for (const l of wrapParts([t.dim(dir), t.dim(S.priceDate(r.meta.pricesAsOf))], t.dim(' · '), bw)) body(l);
  if (r.meta.plan === 'subscription') {
    out.push('');
    note(S.subscriptionNote);
  }

  // ───────── spend ─────────
  const sp = r.spend;
  const total = sp.total.total;
  section(S.title.spend, S.hint.spend, t.bold(money(total)) + ' ' + tag('fact'));
  {
    const subShare = total > 0 ? sp.subagents.total / total : 0;
    body(
      t.dim(S.spend.main + ' ') + t.num(money(sp.main.total)) + t.dim(' · ' + S.spend.subagents + ' ') + t.num(money(sp.subagents.total)) + t.dim(` (${pct(subShare)})`),
    );
    blank();
    const fams = [...sp.byFamily].sort((a, b) => b.cost.total - a.cost.total);
    const top = fams[0]?.cost.total ?? 0;
    const labelW = Math.max(8, ...fams.map((f) => visWidth(f.family)));
    const moneyW = Math.max(...fams.map((f) => money(f.cost.total).length), 5);
    const barW = Math.max(8, bw - labelW - moneyW - 4 - 4);
    for (const f of fams) {
      const share = total > 0 ? f.cost.total / total : 0;
      const b = bar(top > 0 ? f.cost.total / top : 0, barW);
      body(
        padR(t.num(f.family), labelW) + ' ' + t.family(f.family)(b) + ' '.repeat(barW - visWidth(b)) + ' ' + padL(t.num(money(f.cost.total)), moneyW) + ' ' + padL(t.dim(pct(share)), 4),
      );
    }

    blank();
    // daily sparkline
    const days = sp.byDay;
    if (days.length > 0) {
      const range = `${dt(days[0]!.date)} → ${dt(days[days.length - 1]!.date)}`;
      const labelW2 = 10;
      const sparkW = Math.max(10, Math.min(days.length, bw - labelW2 - 1 - 2 - visWidth(range)));
      const vals = downsample(
        days.map((d) => d.cost),
        sparkW,
      );
      const max = Math.max(...vals);
      const spark = vals.map((v) => (v > 0 ? t.accent(sparkChar(v, max)) : t.dim('▁'))).join('');
      body(padR(t.dim(S.spend.byDay), labelW2) + ' ' + spark + '  ' + t.dim(range));
      const peak = days.reduce((a, b) => (b.cost > a.cost ? b : a), days[0]!);
      const avg = total / days.length;
      body(' '.repeat(labelW2 + 1) + t.dim(`${S.spend.peak} `) + t.num(money(peak.cost)) + t.dim(` · ${dt(peak.date)} · ⌀ `) + t.num(money(avg)) + t.dim(r.meta.lang === 'ru' ? '/день' : '/day'));
    }

    if (r.meta.plan === 'subscription' && sp.byWeek.length > 0) {
      blank();
      body(t.dim(S.spend.byWeek + ' · ' + S.spend.weekHint));
      const weeks = sp.byWeek;
      const wMax = Math.max(...weeks.map((w) => w.cost));
      const wLabelW = Math.max(...weeks.map((w) => visWidth(dt(w.weekStart))));
      const wMoneyW = Math.max(...weeks.map((w) => money(w.cost).length));
      const wBarW = Math.max(8, bw - wLabelW - wMoneyW - 2 - visWidth(S.spend.peak) - 1);
      for (const w of weeks) {
        const isPeak = w.cost === wMax && wMax > 0;
        const b = bar(wMax > 0 ? w.cost / wMax : 0, wBarW);
        body(
          padR(t.dim(dt(w.weekStart)), wLabelW) + ' ' + (isPeak ? t.accent(b) : t.sand(b)) + ' '.repeat(wBarW - visWidth(b)) + ' ' + padL(t.num(money(w.cost)), wMoneyW) + (isPeak ? ' ' + t.accent(S.spend.peak) : ''),
        );
      }
    }

    if (sp.byProject.length > 0) {
      blank();
      body(t.dim(S.spend.projects));
      const projects = [...sp.byProject].sort((a, b) => b.cost - a.cost);
      const shown = projects.slice(0, 3);
      const rest = projects.slice(3);
      const pMoneyW = Math.max(...projects.map((p) => money(p.cost).length));
      const rows: Array<[string, number]> = shown.map((p) => [p.project, p.cost]);
      if (rest.length) rows.push([S.spend.more(rest.length), rest.reduce((a, p) => a + p.cost, 0)]);
      rows.forEach(([name, cost], i) => {
        const isRest = i === shown.length && rest.length > 0;
        const nameW = bw - pMoneyW - 6 - 2;
        const label = truncateStart(name, nameW);
        body(padR(isRest ? t.dim(label) : t.num(label), nameW) + '  ' + padL(t.num(money(cost)), pMoneyW) + ' ' + padL(t.dim(pct(total > 0 ? cost / total : 0)), 4));
      });
    }

    const extra: string[] = [];
    if (sp.effortMix.length > 0) {
      const effTotal = sp.effortMix.reduce((a, e) => a + e.cost, 0) || 1;
      blank();
      body(t.dim(S.spend.effort));
      const parts = [...sp.effortMix].sort((a, b) => b.cost - a.cost).map((e) => t.num(e.effort) + ' ' + t.dim(pct(e.cost / effTotal)));
      for (const l of wrapParts(parts, t.dim(' · '), bw)) body(l);
    }
    if (sp.fastModeCost > 0) extra.push(`${S.spend.fast}: ${money(sp.fastModeCost)} (${pct(total > 0 ? sp.fastModeCost / total : 0)})`);
    if (sp.reconciliation.sessionsChecked > 0) extra.push(S.spend.reconcile(sp.reconciliation.sessionsChecked, sp.reconciliation.withinTolerance, sp.reconciliation.medianDeviation, sp.reconciliation.worstDeviation));
    if (extra.length) blank();
    for (const e of extra) note(e);
  }

  // ───────── buckets ─────────
  section(S.title.buckets, S.hint.buckets);
  {
    const c = sp.total;
    const items = [
      { label: S.buckets.cacheWrite, v: c.cacheWrite },
      { label: S.buckets.cacheRead, v: c.cacheRead },
      { label: S.buckets.output, v: c.output },
      { label: S.buckets.input, v: c.input },
    ];
    const cells = allocate(
      items.map((i) => i.v),
      bw,
    );
    body(
      items
        .map((it, i) => {
          const seg = t.segment(i);
          return seg.style(seg.glyph.repeat(cells[i]!));
        })
        .join(''),
    );
    blank();
    const labelW = Math.max(...items.map((i) => visWidth(i.label)));
    const moneyW = Math.max(...items.map((i) => money(i.v).length));
    items.forEach((it, i) => {
      const seg = t.segment(i);
      body(seg.style(seg.glyph) + ' ' + padR(t.num(it.label), labelW) + '  ' + padL(t.num(money(it.v)), moneyW) + ' ' + padL(t.dim(pct(c.total > 0 ? it.v / c.total : 0)), 4));
    });
  }

  // ───────── cache ─────────
  section(S.title.cache, S.hint.cache);
  {
    const labelW = visWidth(S.cache.hit);
    const pctText = pct(r.cache.hitRatio);
    const gaugeW = Math.max(10, bw - labelW - 1 - 4 - 1);
    const filled = bar(r.cache.hitRatio, gaugeW);
    body(padR(t.dim(S.cache.hit), labelW) + ' ' + padL(t.bold(pctText), 4) + ' ' + t.accent(filled) + t.dim('╌'.repeat(gaugeW - visWidth(filled))));
    blank();
    body(spread(t.dim(S.cache.losses), t.num(money(r.cache.rewriteCost)) + ' ' + tag('estimate'), bw));
    const losses = [...r.cache.losses].sort((a, b) => b.cost - a.cost);
    if (losses.length === 0) body(t.dim(S.cache.none));
    const max = losses[0]?.cost ?? 0;
    const lw = Math.max(0, ...losses.map((l) => visWidth(S.cache.cause[l.cause])));
    const ew = Math.max(0, ...losses.map((l) => S.cache.events(l.events).length));
    const mw = Math.max(0, ...losses.map((l) => money(l.cost).length));
    const bW = Math.max(6, bw - lw - ew - mw - 7);
    for (const l of losses) {
      const b = bar(max > 0 ? l.cost / max : 0, bW);
      body(
        padR(t.num(S.cache.cause[l.cause]), lw) + ' ' + padL(t.dim(S.cache.events(l.events)), ew) + '  ' + padL(t.num(money(l.cost)), mw) + ' ' + t.bad(b),
      );
    }
  }

  // ───────── ttl ─────────
  section(S.title.ttl, S.hint.ttl);
  {
    const rec = r.ttl.recommendation;
    const nowTxt = S.ttl.observed(r.ttl.observed);
    let states = t.accent('●') + ' ' + t.dim(S.ttl.now + ' ') + t.num(nowTxt);
    if (rec) states += '    ' + t.accent('○') + ' ' + t.dim(S.ttl.suggest + ' ') + t.num(S.ttl.name(rec.ttl));
    body(states);
    const hist = r.ttl.gapHistogram;
    if (hist.length) {
      blank();
      body(t.dim(S.ttl.gaps));
      const maxC = Math.max(...hist.map((h) => h.count));
      const lw = Math.max(...hist.map((h) => visWidth(h.label)));
      const cw = Math.max(...hist.map((h) => S.n(h.count).length));
      const bW = Math.max(6, bw - lw - cw - 2);
      for (const h of hist) {
        const b = bar(maxC > 0 ? h.count / maxC : 0, bW);
        body(padR(t.dim(h.label), lw) + ' ' + t.sand(b) + ' '.repeat(bW - visWidth(b)) + ' ' + padL(t.num(S.n(h.count)), cw));
      }
    }
    if (rec) {
      blank();
      body(spread(t.dim(S.ttl.saving), t.good('≈ ' + money(rec.monthlySaving.usd)) + t.dim(S.perMonth) + ' ' + tag(rec.monthlySaving.kind), bw));
      note(rec.reason);
    }
  }

  // ───────── tasks ─────────
  section(S.title.tasks, S.hint.tasks);
  {
    const tk = r.tasks;
    line(S.tasks.summary(tk.count, tk.light, pct(tk.count > 0 ? tk.light / tk.count : 0)), '');
    blank();
    kv(S.tasks.lightOnExpensive, t.num(S.n(tk.lightOnExpensive.count)) + '  ' + t.num(money(tk.lightOnExpensive.cost)));
    note(S.tasks.asSonnet(money(tk.lightOnExpensive.asSonnet)), saving(tk.lightOnExpensive.cost - tk.lightOnExpensive.asSonnet) + ' ' + tag('estimate'));
    kv(S.tasks.maxEffort, t.num(S.n(tk.maxEffortOnLight)));
    const ex = tk.topExamples.slice(0, 3);
    if (ex.length) {
      blank();
      body(t.dim(S.tasks.examples));
      const [lq, rq] = r.meta.lang === 'ru' ? ['«', '»'] : ['“', '”'];
      for (const e of ex) {
        const meta = `${shortModel(e.model)}${e.effort ? '·' + e.effort : ''}`;
        const right = t.num(money(e.cost)) + t.dim(' · ' + meta);
        const room = bw - 2 - visWidth(right) - 2;
        const text = lq + truncate(sanitizeInline(e.firstPrompt), room - 2) + rq;
        body(spread(t.dim('⎿ ' + text), right, bw));
      }
    }
  }

  // ───────── subagents ─────────
  section(S.title.subagents, S.hint.subagents);
  {
    const sa = r.subagents;
    line(S.subagents.summary(pct(sa.share), sa.calls, money(sa.cost)), '');
    if (sa.byFamily.length) {
      const parts = [...sa.byFamily].sort((a, b) => b.cost - a.cost).map((f) => t.family(f.family)('●') + ' ' + t.num(f.family) + ' ' + t.dim(money(f.cost)));
      for (const l of wrapParts(parts, '   ', bw)) body(l);
    }
    if (sa.byType.length) {
      blank();
      body(t.dim(S.subagents.byType));
      const types = sa.byType.slice(0, 5);
      const cw = Math.max(...types.map((x) => S.n(x.calls).length));
      const mw = Math.max(...types.map((x) => money(x.cost).length));
      const nameW = bw - cw - mw - 2 - 2 - 2;
      for (const x of types) body(padR(t.num(truncate(x.type, nameW)), nameW) + '  ' + padL(t.dim(S.n(x.calls)), cw) + '  ' + padL(t.num(money(x.cost)), mw));
    }
    const h = sa.haikuCandidates;
    const sn = sa.sonnetCandidates;
    if (h.count > 0 || sn.count > 0) blank();
    if (h.count > 0) {
      note(S.subagents.candidates(h.count, money(h.cost), money(h.asHaiku)) + ',', t.dim(S.subagents.saving) + ' ' + saving(h.cost - h.asHaiku) + ' ' + tag('estimate'));
    }
    if (sn.count > 0) {
      note(S.subagents.sonnetCandidates(sn.count, money(sn.cost), money(sn.asSonnet)) + ', ' + S.subagents.upperBound + ',', t.dim(S.subagents.saving) + ' ' + saving(sn.cost - sn.asSonnet) + ' ' + tag('estimate'));
    }
  }

  // ───────── dead context ─────────
  section(S.title.dead, S.hint.dead);
  {
    const d = r.deadContext;
    line(S.dead.summary(d.events, money(d.cost)), tag('estimate'));
    note(S.dead.advice);
  }

  // ───────── setup ─────────
  section(S.title.setup, S.hint.setup);
  {
    const s = r.setup;
    line(S.setup.prefix(tokens(s.avgFixedPrefixTokens)), t.num(money(s.fixedPrefixCost)) + ' ' + t.dim(S.setup.perPeriod) + ' ' + tag('fact'));
    const files = [...s.claudeMd].sort((a, b) => b.monthlyReadCost - a.monthlyReadCost || b.bytes - a.bytes).slice(0, 3);
    if (files.length) {
      blank();
      const sizeW = Math.max(...files.map((f) => bytes(f.bytes, S.kb, S.mb).length));
      const tokW = Math.max(...files.map((f) => ('≈ ' + tokens(f.tokens)).length));
      const costW = Math.max(...files.map((f) => (money(f.monthlyReadCost) + S.perMonth).length));
      for (const f of files) {
        const nameW = Math.max(8, bw - 2 - sizeW - tokW - costW - 6);
        body(
          t.dim('⎿ ') +
            padR(t.dim(truncateStart(tildify(f.path), nameW)), nameW) +
            '  ' +
            padL(t.num(bytes(f.bytes, S.kb, S.mb)), sizeW) +
            '  ' +
            padL(t.dim('≈ ' + tokens(f.tokens)), tokW) +
            '  ' +
            padL(t.num(money(f.monthlyReadCost)) + t.dim(S.perMonth), costW),
        );
      }
      note(S.setup.readNote);
      if (files.some((f) => f.bytes >= 16 * 1024)) note(S.setup.adviceHeavy);
    }
  }

  // ───────── model switch ─────────
  section(S.title.switch, S.hint.switch);
  {
    const rows = r.switchSim.rows.map((x) => ({
      pair: `${x.from} → ${x.to}`,
      prefix: tokens(x.prefixTokens),
      penalty: money(x.penalty),
      saving: x.savingPerStep > 0 ? '+' + money3(x.savingPerStep) : money3(x.savingPerStep),
      neg: x.savingPerStep <= 0,
      be: x.breakEvenSteps == null ? S.never : S.sw.steps(x.breakEvenSteps),
      never: x.breakEvenSteps == null,
    }));
    const w = {
      prefix: Math.max(visWidth(S.sw.prefix), ...rows.map((x) => x.prefix.length)),
      penalty: Math.max(visWidth(S.sw.penalty), ...rows.map((x) => x.penalty.length)),
      saving: Math.max(visWidth(S.sw.saving), ...rows.map((x) => x.saving.length)),
      be: Math.max(visWidth(S.sw.breakEven), ...rows.map((x) => visWidth(x.be))),
    };
    const pairW = Math.max(8, bw - w.prefix - w.penalty - w.saving - w.be - 8);
    body(padR(t.dim(S.sw.pair), pairW) + '  ' + padL(t.dim(S.sw.prefix), w.prefix) + '  ' + padL(t.dim(S.sw.penalty), w.penalty) + '  ' + padL(t.dim(S.sw.saving), w.saving) + '  ' + padL(t.dim(S.sw.breakEven), w.be));
    body(t.dim('─'.repeat(bw)));
    for (const x of rows) {
      body(
        padR(t.num(truncate(x.pair, pairW)), pairW) +
          '  ' +
          padL(t.dim(x.prefix), w.prefix) +
          '  ' +
          padL(t.bad(x.penalty), w.penalty) +
          '  ' +
          padL(x.neg ? t.bad(x.saving) : t.good(x.saving), w.saving) +
          '  ' +
          padL(x.never ? t.dim(x.be) : t.num(x.be), w.be),
      );
    }
    blank();
    note(S.sw.note);
  }

  // ───────── top actions (boxed) ─────────
  blank();
  {
    const boxW = W - 4;
    const cw = boxW - 4;
    const border = t.accent;
    const row = (content: string): void => void out.push('  ' + border('│') + ' ' + padR(content, cw) + ' ' + border('│'));
    const titleText = ' ' + S.title.actions + ' ';
    out.push('  ' + border('╭─') + t.accentBold(titleText) + border('─'.repeat(boxW - 3 - visWidth(titleText)) + '╮'));
    row('');
    const acts = r.actions.slice(0, 5);
    if (acts.length === 0) row(t.dim(S.actions.empty));
    acts.forEach((a, i) => {
      const amount = t.good('≈ ' + money(a.monthly.usd)) + t.dim(S.perMonth);
      const rw = visWidth(amount);
      const wl = cw - 3 - rw - 2;
      const titleLines = wrapWith(a.title, () => wl);
      const detailLines = wrapWith(a.detail, (k) => (titleLines.length + k < 2 ? wl : cw - 3));
      const right = [amount, tag(a.monthly.kind)];
      const lines: Array<{ text: string }> = [...titleLines.map((x) => ({ text: t.bold(x) })), ...detailLines.map((x) => ({ text: t.dim(x) }))];
      lines.forEach((l, k) => {
        const lead = k === 0 ? t.accentBold(String(i + 1)) + '  ' : '   ';
        const rt = right[k];
        row(rt ? spread(lead + l.text, rt, cw) : lead + l.text);
      });
      if (lines.length < 2) row('   ' + ' '.repeat(Math.max(0, cw - 3 - visWidth(right[1]!))) + right[1]);
      if (i < acts.length - 1) row('');
    });
    if (acts.length > 1) {
      const sum = acts.reduce((a, x) => a + x.monthly.usd, 0);
      const monthly = r.meta.days > 0 ? (total / r.meta.days) * MONTH_DAYS : 0;
      row('');
      row(t.dim('─'.repeat(cw)));
      for (const l of wrap(S.actions.total(money(sum), pct(monthly > 0 ? sum / monthly : 0)) + ' · ' + S.actions.overlap, cw)) row(t.dim(l));
    }
    row('');
    out.push('  ' + border('╰' + '─'.repeat(boxW - 2) + '╯'));
  }

  // ───────── footer ─────────
  blank();
  const dq = S.dataQuality({ dup: r.meta.duplicateRowsDropped, bad: r.meta.badLines, unknown: r.meta.unknownModelCalls });
  if (dq) for (const l of wrap(dq, W - 6)) out.push('  ' + t.dim(l));
  out.push('  ' + t.dim(S.localNote));
  return out.join('\n');
}

