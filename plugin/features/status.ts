import type { AgentoLedger } from '../types';
import { isWarm, warmRemainingMs, type LineageState } from '../core/cache.ts';
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

// `◆ agento · sonnet·med · $1.84 · cache ● 41m` (○ when the main cache went cold).
// Subscribers get their 7-day limit use where the dollars would be.
export function formatStatus(l: AgentoLedger, now: number): string {
  // Claude Code already names the plugin in front of its status line (`agento: …`).
  const parts: string[] = [];
  if (l.main) {
    const eff = shortEffort(l.main.effort);
    parts.push(eff ? `${shortModel(l.main.model)}·${eff}` : shortModel(l.main.model));
  }
  parts.push(l.isSubscription && l.sevenDayPct !== null ? `7d ${Math.round(l.sevenDayPct)}%` : formatUsd(l.cost));
  const cache = l.lineages.main as LineageState | undefined;
  if (cache) {
    if (isWarm(cache, now)) {
      const min = Math.max(1, Math.floor(warmRemainingMs(cache, now) / 60_000));
      parts.push(`cache ● ${min}m`);
    } else {
      parts.push('cache ○');
    }
  }
  return parts.join(' · ');
}
