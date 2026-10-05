// Anthropic list prices, USD per million tokens.
// Source: https://platform.claude.com/docs/en/about-claude/pricing (checked PRICES_AS_OF).

export const PRICES_AS_OF = '2026-10-05';

export type ModelFamily =
  | 'fable-5.1'
  | 'fable-5'
  | 'opus-5.5'
  | 'opus-5'
  | 'opus-4.x'
  | 'sonnet-5.5'
  | 'sonnet-5'
  | 'sonnet-4.x'
  | 'haiku-4.5'
  | 'unknown';

export type KnownFamily = Exclude<ModelFamily, 'unknown'>;

export interface Price {
  input: number;
  write5m: number;
  write1h: number;
  cacheRead: number;
  output: number;
}

export const PRICES: Record<KnownFamily, Price> = {
  'fable-5.1': { input: 10, write5m: 12.5, write1h: 20, cacheRead: 0.25, output: 50 },
  'fable-5': { input: 10, write5m: 12.5, write1h: 20, cacheRead: 1, output: 50 },
  'opus-5.5': { input: 4, write5m: 5, write1h: 8, cacheRead: 0.2, output: 20 },
  'opus-5': { input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 },
  'opus-4.x': { input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 },
  'sonnet-5.5': { input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.2, output: 10 },
  'sonnet-5': { input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.2, output: 10 },
  'sonnet-4.x': { input: 3, write5m: 3.75, write1h: 6, cacheRead: 0.3, output: 15 },
  'haiku-4.5': { input: 1, write5m: 1.25, write1h: 2, cacheRead: 0.1, output: 5 },
};

// Fast mode doubles Opus input and output; cache multipliers stack on top.
export const FAST_MULTIPLIER = 2;

// Families whose effort can change mid-conversation without busting the prompt cache.
export const CACHE_SAFE_EFFORT: ReadonlySet<ModelFamily> = new Set(['opus-5.5', 'sonnet-5.5', 'fable-5.1']);

// Matches ids like `claude-opus-5-5`, `claude-opus-5-5-20260801`, `claude-sonnet-4-6[1m]`, `us.anthropic.claude-haiku-4-5-...`.
const FAMILY_PATTERNS: ReadonlyArray<[RegExp, KnownFamily]> = [
  [/(fable|mythos)-5-1(?!\d)/, 'fable-5.1'],
  [/(fable|mythos)-5(?![-.]?\d)/, 'fable-5'],
  [/opus-5-5(?!\d)/, 'opus-5.5'],
  [/opus-5(?![-.]?\d)/, 'opus-5'],
  [/opus-4-[5-9](?!\d)/, 'opus-4.x'],
  [/sonnet-5-5(?!\d)/, 'sonnet-5.5'],
  [/sonnet-5(?![-.]?\d)/, 'sonnet-5'],
  [/sonnet-4-[5-9](?!\d)/, 'sonnet-4.x'],
  [/haiku-4-5(?!\d)/, 'haiku-4.5'],
];

// Short aliases Claude Code accepts, resolved to the current family.
const ALIASES: Record<string, KnownFamily> = {
  fable: 'fable-5.1',
  best: 'fable-5.1',
  opus: 'opus-5.5',
  sonnet: 'sonnet-5.5',
  haiku: 'haiku-4.5',
};

export function familyOf(modelId: string | undefined | null): ModelFamily {
  if (!modelId) return 'unknown';
  const id = modelId.toLowerCase().replace(/\[.*?\]$/, '').trim();
  const alias = ALIASES[id];
  if (alias) return alias;
  // Date suffixes (`-20260801`) must not be read as a minor version.
  const bare = id.replace(/-\d{8}$/, '');
  for (const [re, family] of FAMILY_PATTERNS) if (re.test(bare)) return family;
  return 'unknown';
}

export function priceOf(modelId: string | undefined | null): Price | null {
  const family = familyOf(modelId);
  return family === 'unknown' ? null : PRICES[family];
}

// Tier used by routing and suggestions; ordered from cheapest to most capable.
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable';
export const TIER_ORDER: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];

export function tierOf(modelId: string | undefined | null): Tier | null {
  const family = familyOf(modelId);
  if (family === 'unknown') return null;
  return family.split('-')[0] as Tier;
}

export function tierRank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

// The model id a tier resolves to when agento suggests or assigns it.
export const TIER_ALIAS: Record<Tier, string> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' };

// The exact id a tier alias resolves to on the first-party API, taken to name the request itself (a `turn.step`
// rewrite needs an id, not an alias). Null when the current model's id is not a plain first-party one
// (a gateway, a cloud provider's own spelling, a `[1m]` variant): there the id of the target is not ours to guess.
const TIER_ID: Record<Tier, string> = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };

export function modelIdForTier(tier: Tier, currentModelId: string): string | null {
  return /^claude-[a-z]+-\d+(?:-\d+)?(?:-\d{8})?$/.test(currentModelId) && familyOf(currentModelId) !== 'unknown' ? TIER_ID[tier] : null;
}
