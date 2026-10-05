import { cacheWriteSplit, prefixTokens } from '../../../plugin/core/cost.ts';
import { TTL_MS } from '../../../plugin/core/cache.ts';
import { priceOf } from '../../../plugin/core/pricing.ts';
import type { ApiCall, Corpus, TtlSection } from '../types.ts';
import { mainCalls } from './cache-misses.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const M = 1_000_000;
const DOMINANT = 0.9;
// Switching 1h -> 5m must save more than this share of the cache spend to be worth recommending.
const CLEARLY_CHEAPER = 0.1;

const BUCKETS: ReadonlyArray<{ label: string; below: number }> = [
  { label: '<1m', below: MIN },
  { label: '1–5m', below: 5 * MIN },
  { label: '5–15m', below: 15 * MIN },
  { label: '15–60m', below: 60 * MIN },
  { label: '>60m', below: Infinity },
];

interface Pair {
  prev: ApiCall;
  cur: ApiCall;
  gap: number;
}

export function analyzeTtl(c: Corpus, now?: number): TtlSection {
  const lines = c.sessions.map(mainCalls);
  const pairs: Pair[] = [];
  const calls: ApiCall[] = [];
  for (const list of lines) {
    calls.push(...list);
    for (let i = 1; i < list.length; i++) pairs.push({ prev: list[i - 1]!, cur: list[i]!, gap: list[i]!.ts - list[i - 1]!.ts });
  }

  const gapHistogram = BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const { gap } of pairs) {
    const i = BUCKETS.findIndex((b) => gap < b.below);
    gapHistogram[i]!.count += 1;
  }

  const observed = observedTtl(calls);
  if (calls.length === 0) return { observed, gapHistogram, recommendation: null };
  const first = Math.min(...calls.map((x) => x.ts));
  const last = Math.max(...calls.map((x) => x.ts));
  const days = Math.max(1, ((now ?? last) - first) / DAY);
  const monthly = (usd: number) => ({ usd: (usd * 30) / days, kind: 'estimate' as const });

  if (observed === '5m') {
    const { saving, premium, rewrites } = simulate1h(pairs, calls);
    const net = saving - premium;
    if (net <= 0) return { observed, gapHistogram, recommendation: null };
    const reason = `${rewrites} cache rewrites after 5–60 min pauses; 1h TTL saves $${saving.toFixed(2)} minus $${premium.toFixed(2)} of 2x write premium`;
    return { observed, gapHistogram, recommendation: { ttl: '1h', monthlySaving: monthly(net), reason } };
  }
  if (observed === '1h') {
    const { premiumSaved, extra, cacheSpend } = simulate5m(pairs, calls);
    const net = premiumSaved - extra;
    if (net <= 0 || net <= CLEARLY_CHEAPER * cacheSpend) return { observed, gapHistogram, recommendation: null };
    const reason = `few pauses of 5–60 min; 5m TTL saves $${premiumSaved.toFixed(2)} of write premium, costs $${extra.toFixed(2)} in rewrites`;
    return { observed, gapHistogram, recommendation: { ttl: '5m', monthlySaving: monthly(net), reason } };
  }
  return { observed, gapHistogram, recommendation: null };
}

function observedTtl(calls: ApiCall[]): TtlSection['observed'] {
  let w5m = 0;
  let w1h = 0;
  for (const x of calls) {
    const b = x.usage.cache_creation;
    if (!b) continue;
    w5m += b.ephemeral_5m_input_tokens ?? 0;
    w1h += b.ephemeral_1h_input_tokens ?? 0;
  }
  const total = w5m + w1h;
  if (total <= 0) return 'unknown';
  if (w1h >= DOMINANT * total) return '1h';
  if (w5m >= DOMINANT * total) return '5m';
  return 'mixed';
}

// Tokens of the previous prefix that were (or would have been) read across a pause.
function across(p: Pair, tokens: number): number {
  return Math.min(tokens, prefixTokens(p.prev.usage));
}

function simulate1h(pairs: Pair[], calls: ApiCall[]) {
  let saving = 0;
  let premium = 0;
  let rewrites = 0;
  const saved = new Map<ApiCall, number>();
  for (const p of pairs) {
    if (p.gap <= TTL_MS['5m'] || p.gap > TTL_MS['1h']) continue;
    const tokens = across(p, p.cur.usage.cache_creation_input_tokens);
    const price = priceOf(p.cur.model);
    if (!price || tokens <= 0) continue;
    saving += (tokens * (price.write5m - price.cacheRead)) / M;
    saved.set(p.cur, tokens);
    rewrites += 1;
  }
  // Every write that remains moves from the 1.25x to the 2x rate.
  for (const x of calls) {
    const price = priceOf(x.model);
    if (!price) continue;
    const remaining = Math.max(0, cacheWriteSplit(x.usage).w5m - (saved.get(x) ?? 0));
    premium += (remaining * (price.write1h - price.write5m)) / M;
  }
  return { saving, premium, rewrites };
}

function simulate5m(pairs: Pair[], calls: ApiCall[]) {
  let premiumSaved = 0;
  let extra = 0;
  let cacheSpend = 0;
  for (const x of calls) {
    const price = priceOf(x.model);
    if (!price) continue;
    const { w5m, w1h } = cacheWriteSplit(x.usage);
    premiumSaved += (w1h * (price.write1h - price.write5m)) / M;
    cacheSpend += ((w5m * price.write5m + w1h * price.write1h + x.usage.cache_read_input_tokens * price.cacheRead) / M);
  }
  // Pauses of 5–60 min would turn reads into rewrites.
  for (const p of pairs) {
    if (p.gap <= TTL_MS['5m'] || p.gap > TTL_MS['1h']) continue;
    const price = priceOf(p.cur.model);
    if (!price) continue;
    extra += (across(p, p.cur.usage.cache_read_input_tokens) * (price.write5m - price.cacheRead)) / M;
  }
  return { premiumSaved, extra, cacheSpend };
}
