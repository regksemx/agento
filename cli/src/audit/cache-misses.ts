import { costWithPrice, normalizeUsage, prefixTokens, type Usage } from '../../../plugin/core/cost.ts';
import { TTL_MS, ttlOfUsage, type Ttl } from '../../../plugin/core/cache.ts';
import { CACHE_SAFE_EFFORT, familyOf, priceOf } from '../../../plugin/core/pricing.ts';
import type { ApiCall, CacheSection, Corpus, MissCause, SessionData } from '../types.ts';

export const REWRITE_SHARE = 0.2;
export const REWRITE_MIN_PREFIX = 8_000;

const CAUSES: readonly MissCause[] = ['ttl', 'model-switch', 'compaction', 'effort-change', 'unknown'];

export function mainCalls(s: SessionData): ApiCall[] {
  return s.calls.filter((c) => c.lineage === 'main').sort((a, b) => a.ts - b.ts);
}

// Cost of the rewritten tokens minus what reading them would have cost; never negative.
export function rewriteLoss(call: ApiCall): number {
  const p = priceOf(call.model);
  if (!p) return 0;
  const written: Usage = normalizeUsage({
    cache_creation_input_tokens: call.usage.cache_creation_input_tokens,
    cache_creation: call.usage.cache_creation,
    speed: call.usage.speed,
  });
  const write = costWithPrice(p, written).cacheWrite;
  const read = costWithPrice(p, normalizeUsage({ cache_read_input_tokens: call.usage.cache_creation_input_tokens, speed: call.usage.speed })).cacheRead;
  return Math.max(0, write - read);
}

export function isRewrite(call: ApiCall): boolean {
  const prefix = prefixTokens(call.usage);
  return prefix >= REWRITE_MIN_PREFIX && call.usage.cache_creation_input_tokens > REWRITE_SHARE * prefix;
}

export function analyzeCacheMisses(c: Corpus): CacheSection {
  let read = 0;
  let total = 0;
  const losses = new Map<MissCause, { events: number; cost: number }>(CAUSES.map((k) => [k, { events: 0, cost: 0 }]));

  for (const s of c.sessions) {
    const calls = mainCalls(s);
    let ttl: Ttl = '5m'; // TTL in force after the previous call; carries over through read-only calls
    for (let i = 0; i < calls.length; i++) {
      const cur = calls[i]!;
      const prev = calls[i - 1];
      read += cur.usage.cache_read_input_tokens;
      total += prefixTokens(cur.usage);
      if (prev && isRewrite(cur)) {
        const cause = classify(s, prev, cur, ttl);
        const bucket = losses.get(cause)!;
        bucket.events += 1;
        bucket.cost += rewriteLoss(cur);
      }
      ttl = ttlOfUsage(cur.usage, ttl);
    }
  }

  const list = CAUSES.map((cause) => ({ cause, ...losses.get(cause)! }));
  return { hitRatio: total > 0 ? read / total : 0, rewriteCost: list.reduce((a, l) => a + l.cost, 0), losses: list };
}

function classify(s: SessionData, prev: ApiCall, cur: ApiCall, prevTtl: Ttl): MissCause {
  if (s.markers.some((m) => (m.kind === 'compact' || m.kind === 'clear') && m.ts > prev.ts && m.ts <= cur.ts)) return 'compaction';
  if (cur.model !== prev.model) return 'model-switch';
  if (cur.ts - prev.ts > TTL_MS[prevTtl]) return 'ttl';
  if (cur.effort !== undefined && prev.effort !== undefined && cur.effort !== prev.effort && !CACHE_SAFE_EFFORT.has(familyOf(cur.model))) return 'effort-change';
  return 'unknown';
}
