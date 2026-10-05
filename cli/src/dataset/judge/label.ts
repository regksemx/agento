// Derived L1 label: the cheapest configuration of the ladder whose probability reaches the threshold, else opus·medium.

import { JUDGE_CONFIGS, type JudgeLabel, type JudgeProbs } from './types.ts';

export const DEFAULT_THRESHOLD = 0.7;

export function deriveLabel(probs: JudgeProbs, threshold = DEFAULT_THRESHOLD): JudgeLabel {
  for (const c of JUDGE_CONFIGS) if (probs[c.id] >= threshold) return { tier: c.tier, effort: c.effort };
  return { tier: 'opus', effort: 'medium' };
}
