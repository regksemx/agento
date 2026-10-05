// Per-task receipt: what the task cost and what agento saved on it. Pure.

import type { AgentoMechanism, AgentoTaskBooks } from '../types';
import type { BannerBase, MoneyCtx } from './banner.ts';
import { fmtPct, formatUsd } from './status.ts';
import type { Lang } from './strings.ts';

// `0.4% недели` for a calibrated subscriber, else dollars.
export function amountText(usd: number, m: MoneyCtx): string {
  const ru = m.lang === 'ru';
  if (m.isSubscription && m.pctPerUsd !== null) return `${fmtPct(usd * m.pctPerUsd)} ${ru ? 'недели' : 'of the week'}`;
  return formatUsd(usd);
}

export function fmtTokensShort(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

export function savedSum(saved: AgentoTaskBooks['saved']): number {
  let sum = 0;
  for (const v of Object.values(saved ?? {})) sum += v ?? 0;
  return sum;
}

function cheaperText(cheaper: Record<string, number> | undefined, ru: boolean): string {
  const parts = Object.entries(cheaper ?? {})
    .filter(([, n]) => n > 0)
    .map(([tier, n]) => `${tier} ×${n}`);
  if (parts.length === 0) return ru ? 'субагенты на дешёвых моделях' : 'subagents on cheaper models';
  return ru ? `субагенты: ${parts.join(', ')}` : `subagents: ${parts.join(', ')}`;
}

// What each mechanism is called in a receipt.
export function mechanismText(m: AgentoMechanism, b: Pick<AgentoTaskBooks, 'cheaper' | 'prunedTokens'>, lang: Lang): string {
  const ru = lang === 'ru';
  switch (m) {
    case 'spawn-routing':
      return cheaperText(b.cheaper, ru);
    case 'autopilot':
      return ru ? 'автопилот выбрал модель дешевле' : 'autopilot picked a cheaper model';
    case 'suggestion-accepted':
      return ru ? 'принятая подсказка' : 'accepted suggestion';
    case 'handoff':
      return ru ? 'код по плану на Sonnet' : 'plan coded on Sonnet';
    case 'prune':
      return ru ? `убраны старые выводы (−${fmtTokensShort(b.prunedTokens ?? 0)} токенов)` : `pruned stale outputs (−${fmtTokensShort(b.prunedTokens ?? 0)} tokens)`;
  }
}

const ORDER: AgentoMechanism[] = ['autopilot', 'spawn-routing', 'handoff', 'suggestion-accepted', 'prune'];

export interface ReceiptInput {
  books: AgentoTaskBooks;
  money: MoneyCtx;
  // The 7-day limit reading now, when the account reports one.
  sevenDayPct: number | null;
}

// The task's cost as a share of the week: the limit's own movement when both readings exist, else the calibration.
export function taskShare(i: ReceiptInput): string {
  const ru = i.money.lang === 'ru';
  const usd = i.books.total ?? i.books.cost;
  const start = i.books.sevenDayPctAtStart;
  if (i.money.isSubscription && start !== null && start !== undefined && i.sevenDayPct !== null && i.sevenDayPct >= start) {
    return `${fmtPct(Math.max(i.sevenDayPct - start, 0.01))} ${ru ? 'недели' : 'of the week'}`;
  }
  return amountText(usd, i.money);
}

export function receiptBanner(i: ReceiptInput): BannerBase | null {
  const b = i.books;
  const total = b.total ?? b.cost;
  if (!(total > 0)) return null;
  const ru = i.money.lang === 'ru';
  const saved = savedSum(b.saved);
  const title = ru ? `Задача обошлась в ${taskShare(i)}` : `This task cost ${taskShare(i)}`;
  let reason: string;
  if (saved > 0) {
    const how = ORDER.filter((m) => (b.saved?.[m] ?? 0) > 0).map((m) => mechanismText(m, b, i.money.lang));
    reason = ru ? `agento сэкономил ≈${amountText(saved, i.money)}: ${how.join(', ')}` : `agento saved ≈${amountText(saved, i.money)}: ${how.join(', ')}`;
  } else {
    reason = ru ? 'agento здесь ничего не менял' : 'agento changed nothing here';
  }
  const estimate = saved > 0 ? (ru ? 'расход — факт, экономия — оценка' : 'cost measured, savings estimated') : null;
  return {
    scenario: 'RC',
    title,
    reason,
    estimate,
    actions: [{ key: 'details', label: ru ? 'Подробнее' : 'Details' }],
    data: {},
  };
}
