// TwinRouterBench tiers -> agento tiers. Rationale and caveats: docs/public-data.md.
//
// TwinRouterBench ladder (data/dynamic/tier_to_model.json and twinrouterbench/data_generation/model_pool_v2.json): low = DeepSeek-V3.2 /
// GLM-4.5-Air / Qwen3.5-9B, mid = MiniMax-M2.5 / Qwen3.5-27B / Qwen3-Coder, mid_high = Claude Haiku 4.5 / Gemini 3 Flash / Qwen3.5-397B,
// high = Claude Opus 4.6 / GPT-5.4. A tier "passes" a step when at least one pool model of that tier passes it, and the label is the
// cheapest tier that passes (downgrade-and-cascade, execution-verified).
//
// Claude Haiku 4.5 itself sits in mid_high, so steps that low or mid models already pass are certainly within reach of Haiku. A step
// that needs mid_high is the Haiku/Flash class: only one of three models has to pass, so "Haiku suffices" is not established and the
// conservative reading is sonnet. A step that needs high needs the frontier class: opus.

import type { TaskTier } from '../../../../plugin/core/task.ts';

export const PUBLIC_TIERS = ['low', 'mid', 'mid_high', 'high'] as const;
export type PublicTier = (typeof PUBLIC_TIERS)[number];

export const TIER_MAP: Record<PublicTier, TaskTier> = {
  low: 'haiku',
  mid: 'haiku',
  mid_high: 'sonnet',
  high: 'opus',
};

export const TIER_ID: Record<PublicTier, number> = { low: 0, mid: 1, mid_high: 2, high: 3 };

export function isPublicTier(x: unknown): x is PublicTier {
  return typeof x === 'string' && (PUBLIC_TIERS as readonly string[]).includes(x);
}

// The tier of a row: `target_tier`, or the one `target_tier_id` names. Conflicting fields are rejected (the dataset's own publish check
// requires them to agree).
export function publicTierOf(row: { target_tier?: unknown; target_tier_id?: unknown }): PublicTier | undefined {
  const byName = isPublicTier(row.target_tier) ? row.target_tier : undefined;
  const id = typeof row.target_tier_id === 'number' ? row.target_tier_id : undefined;
  const byId = id !== undefined && Number.isInteger(id) ? PUBLIC_TIERS[id] : undefined;
  if (byName && byId && byName !== byId) return undefined;
  return byName ?? byId;
}
