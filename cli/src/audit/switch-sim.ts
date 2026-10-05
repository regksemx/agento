import { costWithPrice, normalizeUsage } from '../../../plugin/core/cost.ts';
import { switchPenalty, type LineageState } from '../../../plugin/core/cache.ts';
import { priceOf } from '../../../plugin/core/pricing.ts';
import type { Corpus, SwitchSimSection } from '../types.ts';
import { mainCalls } from './cache-misses.ts';

const PAIRS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['opus-5.5', 'sonnet-5.5', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  ['opus-5.5', 'haiku-4.5', 'claude-opus-5-5', 'claude-haiku-4-5'],
  ['fable-5.1', 'opus-5.5', 'claude-fable-5-1', 'claude-opus-5-5'],
  ['opus-5', 'sonnet-5.5', 'claude-opus-5', 'claude-sonnet-5-5'],
];

// Nearest-rank quantile of an unsorted list.
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export function simulateSwitches(c: Corpus): SwitchSimSection {
  const calls = c.sessions.flatMap(mainCalls);
  const prefixes = calls.map((x) => x.usage.input_tokens + x.usage.cache_read_input_tokens + x.usage.cache_creation_input_tokens).filter((n) => n > 0);
  if (prefixes.length === 0) return { rows: [] };
  const fresh = quantile(calls.map((x) => x.usage.cache_creation_input_tokens), 0.5);
  const output = quantile(calls.map((x) => x.usage.output_tokens), 0.5);

  const rows: SwitchSimSection['rows'] = [];
  for (const prefix of [Math.round(quantile(prefixes, 0.5)), Math.round(quantile(prefixes, 0.9))]) {
    for (const [from, to, fromId, toId] of PAIRS) {
      const pFrom = priceOf(fromId);
      const pTo = priceOf(toId);
      if (!pFrom || !pTo) continue;
      // Warm lineage: the previous call has just happened.
      const state: LineageState = { model: fromId, prefixTokens: prefix, lastAt: 0, ttl: '5m' };
      const penalty = switchPenalty(state, toId, 0);
      if (penalty === null) continue;
      const step = normalizeUsage({ cache_read_input_tokens: prefix, cache_creation_input_tokens: fresh, output_tokens: output });
      const savingPerStep = costWithPrice(pFrom, step).total - costWithPrice(pTo, step).total;
      rows.push({ from, to, prefixTokens: prefix, penalty, savingPerStep, breakEvenSteps: savingPerStep > 0 ? Math.max(1, Math.ceil(penalty / savingPerStep)) : null });
    }
  }
  return { rows };
}
