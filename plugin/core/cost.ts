import { FAST_MULTIPLIER, priceOf, type Price } from './pricing.ts';

// Token usage as the Messages API reports it (and as Claude Code records it in transcripts).
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  speed?: string | null;
}

export interface CostBreakdown {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

const M = 1_000_000;

export function normalizeUsage(u: Partial<Usage> | null | undefined): Usage {
  return {
    input_tokens: num(u?.input_tokens),
    output_tokens: num(u?.output_tokens),
    cache_read_input_tokens: num(u?.cache_read_input_tokens),
    cache_creation_input_tokens: num(u?.cache_creation_input_tokens),
    cache_creation: u?.cache_creation ?? null,
    speed: u?.speed ?? null,
  };
}

export function prefixTokens(u: Usage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

// Splits cache writes into 5m and 1h buckets. Without a breakdown everything counts as 5m.
export function cacheWriteSplit(u: Usage): { w5m: number; w1h: number } {
  const total = u.cache_creation_input_tokens;
  const w1h = Math.min(total, num(u.cache_creation?.ephemeral_1h_input_tokens));
  const reported5m = u.cache_creation?.ephemeral_5m_input_tokens;
  const w5m = reported5m === undefined ? total - w1h : Math.min(total - w1h, num(reported5m));
  // Any remainder the breakdown does not explain is billed at the 5m rate.
  return { w5m: w5m + Math.max(0, total - w1h - w5m), w1h };
}

export function costWithPrice(p: Price, u: Usage): CostBreakdown {
  const fast = u.speed === 'fast' ? FAST_MULTIPLIER : 1;
  const { w5m, w1h } = cacheWriteSplit(u);
  const input = (u.input_tokens * p.input * fast) / M;
  const cacheWrite = ((w5m * p.write5m + w1h * p.write1h) * fast) / M;
  const cacheRead = (u.cache_read_input_tokens * p.cacheRead * fast) / M;
  const output = (u.output_tokens * p.output * fast) / M;
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output };
}

export function costOf(modelId: string | null | undefined, u: Usage): CostBreakdown | null {
  const p = priceOf(modelId);
  return p ? costWithPrice(p, u) : null;
}

// The same tokens priced as another model: an upper-bound estimate, since a different model
// would have taken a different trajectory. Fast mode is not carried over.
export function repriceAs(targetModelId: string, u: Usage): CostBreakdown | null {
  return costOf(targetModelId, { ...u, speed: null });
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

export const ZERO_COST: CostBreakdown = Object.freeze({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 });

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
