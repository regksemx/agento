import type { AgentoLedger } from '../types';
import { tierOf } from '../core/pricing.ts';

const EFFORT_SHORT: Record<string, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' };

export function shortModel(model: string): string {
  return tierOf(model) ?? (model.length > 14 ? `${model.slice(0, 13)}…` : model);
}

export function shortEffort(effort: string | null | undefined): string | null {
  if (effort === null || effort === undefined || effort === '') return null;
  return EFFORT_SHORT[effort] ?? effort;
}

export function formatUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

// A share of the weekly limit: `0.6%`, `3%`, `<0.1%`.
export function fmtPct(p: number): string {
  if (p < 0.1) return '<0.1%';
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

export interface StatusMoney {
  lang: 'ru' | 'en';
  isSubscription: boolean;
  pctPerUsd: number | null;
}

function money(usd: number, m: StatusMoney): string {
  return m.isSubscription && m.pctPerUsd !== null ? fmtPct(usd * m.pctPerUsd) : formatUsd(usd);
}

// `7d 63% · task 0.4% · saved ≈1.2%`; API key: `$1.84 · task $0.31 · saved ≈$0.40`.
// `taskUsd`: the running task's cost, all lineages; `savedUsd`: the session's savings.
export function formatStatus(l: AgentoLedger, m: StatusMoney, taskUsd: number | null, savedUsd: number): string {
  const ru = m.lang === 'ru';
  const parts: string[] = [];
  parts.push(l.isSubscription && l.sevenDayPct !== null ? `${ru ? '7д' : '7d'} ${Math.round(l.sevenDayPct)}%` : formatUsd(l.cost));
  if (taskUsd !== null && taskUsd > 0) parts.push(`${ru ? 'задача' : 'task'} ${money(taskUsd, m)}`);
  if (savedUsd > 0) parts.push(`${ru ? 'сэкономлено' : 'saved'} ≈${money(savedUsd, m)}`);
  return parts.join(' · ');
}
