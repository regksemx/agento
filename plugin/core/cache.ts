import { priceOf } from './pricing.ts';
import { prefixTokens, type Usage } from './cost.ts';

// Each lineage (main thread, or one subagent) has its own prompt cache.
export type Lineage = 'main' | `agent:${string}`;

export type Ttl = '5m' | '1h';
export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

// Treat the cache as cold a little before it actually expires.
export const COLD_MARGIN_MS = 30_000;

export interface LineageState {
  model: string;
  prefixTokens: number;
  lastAt: number;
  ttl: Ttl;
}

export function ttlOfUsage(u: Usage, fallback: Ttl): Ttl {
  if ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h';
  if ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m';
  return fallback;
}

export function nextLineageState(prev: LineageState | undefined, model: string, u: Usage, at: number, fallbackTtl: Ttl): LineageState {
  return { model, prefixTokens: prefixTokens(u), lastAt: at, ttl: ttlOfUsage(u, prev?.ttl ?? fallbackTtl) };
}

export function isWarm(s: LineageState, now: number): boolean {
  return now - s.lastAt < TTL_MS[s.ttl] - COLD_MARGIN_MS;
}

export function warmRemainingMs(s: LineageState, now: number): number {
  return Math.max(0, TTL_MS[s.ttl] - COLD_MARGIN_MS - (now - s.lastAt));
}

// Cost of writing a prefix of `tokens` into the target model's cache.
export function rewriteCost(targetModelId: string, tokens: number, ttl: Ttl): number | null {
  const p = priceOf(targetModelId);
  if (!p) return null;
  return (tokens * (ttl === '1h' ? p.write1h : p.write5m)) / 1_000_000;
}

// Extra cost of moving this lineage to another model now, versus staying.
// Warm: the new model writes the whole prefix instead of the old one reading it.
// Cold: the prefix gets written either way, so only the price difference of the write remains.
export function switchPenalty(s: LineageState, targetModelId: string, now: number): number | null {
  const write = rewriteCost(targetModelId, s.prefixTokens, s.ttl);
  const cur = priceOf(s.model);
  if (write === null || !cur) return null;
  if (!isWarm(s, now)) {
    const stayWrite = rewriteCost(s.model, s.prefixTokens, s.ttl) ?? 0;
    return write - stayWrite;
  }
  return write - (s.prefixTokens * cur.cacheRead) / 1_000_000;
}
