// GitHub-flavored Markdown renderer: same sections as the terminal, suitable for pasting into an issue.

import type { AuditReport, Confidence } from '../types.ts';
import { bar, bytes, downsample, localStamp, money, money3, pct, sanitizeInline, shortModel, sparkChar, tildify, tokens, truncate } from './format.ts';
import { dateShort, strings } from './i18n.ts';

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function table(head: string[], rows: string[][], align: Array<'l' | 'r'> = []): string[] {
  const sep = head.map((_, i) => (align[i] === 'r' ? '---:' : '---'));
  return ['| ' + head.map(esc).join(' | ') + ' |', '| ' + sep.join(' | ') + ' |', ...rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |')];
}

export function renderMarkdown(r: AuditReport): string {
  const S = strings(r.meta.lang);
  const out: string[] = [];
  const push = (...l: string[]): void => void out.push(...l);
  const tag = (k: Confidence): string => `*${k === 'fact' ? S.fact : S.estimate}*`;
  const dt = (iso: string): string => dateShort(iso, S);
  const sp = r.spend;
  const total = sp.total.total;
  const section = (title: string, hint: string, right = ''): void => {
    push('', `## ${title}${right ? ' · ' + right : ''}`, '');
    if (hint) push(`*${hint}*`, '');
  };

  push('# ◆ agento audit', '');
  push(`> ${[S.days(r.meta.days), S.sessions(r.meta.sessions), S.requests(r.meta.calls)].join(' · ')}  `);
  push(`> \`${r.meta.dir}\` · ${S.priceDate(r.meta.pricesAsOf)} · ${localStamp(r.meta.generatedAt)}`);
  if (r.meta.plan === 'subscription') push('>', `> ⎿ ${S.subscriptionNote}`);

  section(S.title.spend, S.hint.spend, `**${money(total)}** ${tag('fact')}`);
  push(`${S.spend.main}: ${money(sp.main.total)} · ${S.spend.subagents}: ${money(sp.subagents.total)} (${pct(total > 0 ? sp.subagents.total / total : 0)})`, '');
  const fams = [...sp.byFamily].sort((a, b) => b.cost.total - a.cost.total);
  const top = fams[0]?.cost.total ?? 0;
  push(
    ...table(
      [S.col.model, S.col.requests, S.col.cost, S.col.share, ''],
      fams.map((f) => [`\`${f.family}\``, S.n(f.calls), money(f.cost.total), pct(total > 0 ? f.cost.total / total : 0), '`' + bar(top > 0 ? f.cost.total / top : 0, 20) + '`']),
      ['l', 'r', 'r', 'r', 'l'],
    ),
  );
  if (sp.byDay.length) {
    const vals = downsample(sp.byDay.map((d) => d.cost), 60);
    const max = Math.max(...vals);
    const first = sp.byDay[0]!.date;
    const last = sp.byDay[sp.byDay.length - 1]!.date;
    push('', `${S.spend.byDay}: \`${vals.map((v) => sparkChar(v, max)).join('')}\` ${dt(first)} → ${dt(last)}`);
  }
  if (r.meta.plan === 'subscription' && sp.byWeek.length) {
    const max = Math.max(...sp.byWeek.map((w) => w.cost));
    push('', `**${S.spend.byWeek}** — ${S.spend.weekHint}`, '');
    push(...table([S.col.week, S.col.cost, ''], sp.byWeek.map((w) => [dt(w.weekStart), money(w.cost), '`' + bar(max > 0 ? w.cost / max : 0, 20) + '`' + (w.cost === max ? ' ' + S.spend.peak : '')]), ['l', 'r', 'l']));
  }
  if (sp.byProject.length) {
    const ps = [...sp.byProject].sort((a, b) => b.cost - a.cost).slice(0, 5);
    push('', `**${S.spend.projects}**`, '');
    push(...table([S.col.project, S.col.sessions, S.col.cost, S.col.share], ps.map((p) => [`\`${p.project}\``, S.n(p.sessions), money(p.cost), pct(total > 0 ? p.cost / total : 0)]), ['l', 'r', 'r', 'r']));
    if (sp.byProject.length > ps.length) push('', `*${S.spend.more(sp.byProject.length - ps.length)}*`);
  }
  if (sp.effortMix.length) {
    const et = sp.effortMix.reduce((a, e) => a + e.cost, 0) || 1;
    push('', `**${S.spend.effort}:** ` + [...sp.effortMix].sort((a, b) => b.cost - a.cost).map((e) => `\`${e.effort}\` ${pct(e.cost / et)}`).join(' · '));
  }
  const notes: string[] = [];
  if (sp.fastModeCost > 0) notes.push(`- ${S.spend.fast}: ${money(sp.fastModeCost)} (${pct(total > 0 ? sp.fastModeCost / total : 0)})`);
  if (sp.reconciliation.sessionsChecked > 0) notes.push(`- ${S.spend.reconcile(sp.reconciliation.sessionsChecked, sp.reconciliation.withinTolerance, sp.reconciliation.medianDeviation, sp.reconciliation.worstDeviation)}`);
  if (notes.length) push('', ...notes);

  section(S.title.buckets, S.hint.buckets);
  const c = sp.total;
  push(
    ...table(
      [S.col.bucket, S.col.cost, S.col.share],
      [
        [S.buckets.cacheWrite, c.cacheWrite],
        [S.buckets.cacheRead, c.cacheRead],
        [S.buckets.output, c.output],
        [S.buckets.input, c.input],
      ].map(([l, v]) => [l as string, money(v as number), pct(c.total > 0 ? (v as number) / c.total : 0)]),
      ['l', 'r', 'r'],
    ),
  );

  section(S.title.cache, S.hint.cache);
  push(`**${S.cache.hit}:** ${pct(r.cache.hitRatio)} (${S.cache.hitHint})`, '');
  push(`**${S.cache.losses}:** ${money(r.cache.rewriteCost)} ${tag('estimate')}`, '');
  if (r.cache.losses.length) {
    push(...table([S.col.cause, S.col.events, S.col.cost], [...r.cache.losses].sort((a, b) => b.cost - a.cost).map((l) => [S.cache.cause[l.cause], S.n(l.events), money(l.cost)]), ['l', 'r', 'r']));
  } else push(S.cache.none);

  section(S.title.ttl, S.hint.ttl);
  const rec = r.ttl.recommendation;
  push(`- ● ${S.ttl.now}: **${S.ttl.observed(r.ttl.observed)}**`);
  if (rec) push(`- ○ ${S.ttl.suggest}: **${S.ttl.name(rec.ttl)}** — ≈ ${money(rec.monthlySaving.usd)}${S.perMonth} ${tag(rec.monthlySaving.kind)}`);
  if (r.ttl.gapHistogram.length) {
    const max = Math.max(...r.ttl.gapHistogram.map((h) => h.count));
    push('', `**${S.ttl.gaps}**`, '');
    push(...table([S.col.gap, S.col.count, ''], r.ttl.gapHistogram.map((h) => [h.label, S.n(h.count), '`' + bar(max > 0 ? h.count / max : 0, 20) + '`']), ['l', 'r', 'l']));
  }
  if (rec) push('', `> ${rec.reason}`);

  section(S.title.tasks, S.hint.tasks);
  const tk = r.tasks;
  push(S.tasks.summary(tk.count, tk.light, pct(tk.count > 0 ? tk.light / tk.count : 0)), '');
  push(`- ${S.tasks.lightOnExpensive}: **${S.n(tk.lightOnExpensive.count)}** · ${money(tk.lightOnExpensive.cost)}`);
  push(`- ${S.tasks.asSonnet(money(tk.lightOnExpensive.asSonnet))} **−${money(tk.lightOnExpensive.cost - tk.lightOnExpensive.asSonnet)}** ${tag('estimate')}`);
  push(`- ${S.tasks.maxEffort}: **${S.n(tk.maxEffortOnLight)}**`);
  if (tk.topExamples.length) {
    push('', `**${S.tasks.examples}**`, '');
    push(
      ...table(
        [S.col.task, S.col.model1, S.col.cost],
        tk.topExamples.slice(0, 3).map((e) => [truncate(sanitizeInline(e.firstPrompt), 80), `\`${shortModel(e.model)}${e.effort ? '·' + e.effort : ''}\``, money(e.cost)]),
        ['l', 'l', 'r'],
      ),
    );
  }

  section(S.title.subagents, S.hint.subagents);
  const sa = r.subagents;
  push(S.subagents.summary(pct(sa.share), sa.calls, money(sa.cost)));
  if (sa.byFamily.length) push('', [...sa.byFamily].sort((a, b) => b.cost - a.cost).map((f) => `\`${f.family}\` ${money(f.cost)}`).join(' · '));
  if (sa.byType.length) {
    push('', `**${S.subagents.byType}**`, '');
    push(...table([S.col.type, S.col.requests, S.col.cost], sa.byType.slice(0, 5).map((x) => [`\`${x.type}\``, S.n(x.calls), money(x.cost)]), ['l', 'r', 'r']));
  }
  const h = sa.haikuCandidates;
  const sn = sa.sonnetCandidates;
  if (h.count > 0) push('', `- ${S.subagents.candidates(h.count, money(h.cost), money(h.asHaiku))} — ${S.subagents.saving} **−${money(h.cost - h.asHaiku)}** ${tag('estimate')}`);
  if (sn.count > 0) push(...(h.count > 0 ? [] : ['']), `- ${S.subagents.sonnetCandidates(sn.count, money(sn.cost), money(sn.asSonnet))} — ${S.subagents.upperBound}, ${S.subagents.saving} **−${money(sn.cost - sn.asSonnet)}** ${tag('estimate')}`);

  section(S.title.dead, S.hint.dead);
  push(`${S.dead.summary(r.deadContext.events, `**${money(r.deadContext.cost)}**`)} ${tag('estimate')}`, '', `- ${S.dead.advice}`);

  section(S.title.setup, S.hint.setup);
  push(`${S.setup.prefix(tokens(r.setup.avgFixedPrefixTokens))} **${money(r.setup.fixedPrefixCost)}** ${S.setup.perPeriod} ${tag('fact')}`);
  if (r.setup.claudeMd.length) {
    push('');
    push(
      ...table(
        [S.col.file, S.col.size, S.col.tokens, S.col.readCost],
        [...r.setup.claudeMd]
          .sort((a, b) => b.monthlyReadCost - a.monthlyReadCost || b.bytes - a.bytes)
          .slice(0, 3)
          .map((f) => [`\`${tildify(f.path)}\``, bytes(f.bytes, S.kb, S.mb), '≈ ' + tokens(f.tokens), money(f.monthlyReadCost) + S.perMonth]),
        ['l', 'r', 'r', 'r'],
      ),
    );
    push('', `*${S.setup.readNote}*`);
  }

  section(S.title.switch, S.hint.switch);
  push(
    ...table(
      [S.sw.pair, S.sw.prefix, S.sw.penalty, S.sw.saving, S.sw.breakEven],
      r.switchSim.rows.map((x) => [`\`${x.from}\` → \`${x.to}\``, tokens(x.prefixTokens), money(x.penalty), (x.savingPerStep > 0 ? '+' : '') + money3(x.savingPerStep), x.breakEvenSteps == null ? S.never : S.sw.steps(x.breakEvenSteps)]),
      ['l', 'r', 'r', 'r', 'r'],
    ),
  );
  push('', `> ${S.sw.note}`);

  section(S.title.actions, '');
  if (r.actions.length === 0) push(S.actions.empty);
  const acts = r.actions.slice(0, 5);
  acts.forEach((a, i) => push(`${i + 1}. **${a.title}** — ≈ ${money(a.monthly.usd)}${S.perMonth} ${tag(a.monthly.kind)}  `, `   ${a.detail}`));
  if (acts.length > 1) {
    const sum = acts.reduce((a, x) => a + x.monthly.usd, 0);
    const monthly = r.meta.days > 0 ? (total / r.meta.days) * 30 : 0;
    push('', `*${S.actions.total(money(sum), pct(monthly > 0 ? sum / monthly : 0))}; ${S.actions.overlap}.*`);
  }

  const dq = S.dataQuality({ dup: r.meta.duplicateRowsDropped, bad: r.meta.badLines, unknown: r.meta.unknownModelCalls });
  push('', '---', '', `<sub>${dq ? dq + ' · ' : ''}${S.localNote}</sub>`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
