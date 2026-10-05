// --dry-run and the claude confirmation: how many tasks, roughly how many tokens, and what that costs. No network, no spawn.

import { priceOf } from '../../../../plugin/core/pricing.ts';
import type { JudgeTask } from '../types.ts';
import { buildJudgePrompt, estimateTokens, EST_OUTPUT_TOKENS } from './prompt.ts';
import type { JudgeBackendKind } from './types.ts';

// Claude Code adds a little of its own to every `-p` call even with tools off and a custom system prompt.
export const CLAUDE_OVERHEAD_TOKENS = 1500;

export interface Estimate {
  backend: JudgeBackendKind;
  model: string;
  totalTasks: number;
  judgedAlready: number;
  tasks: number; // to judge now
  systemTokens: number;
  inputTokens: number; // all calls, system prompt included
  outputTokens: number;
  costUsd?: number; // API-equivalent, claude backend only (no caching assumed, so an upper bound)
  priceKnown: boolean;
}

export function estimateRun(o: { backend: JudgeBackendKind; model: string; pending: readonly JudgeTask[]; totalTasks: number; judgedAlready: number }): Estimate {
  let userChars = 0;
  let systemChars = 0;
  for (const t of o.pending) {
    const p = buildJudgePrompt(t);
    userChars += p.user.length;
    systemChars = p.system.length;
  }
  const n = o.pending.length;
  const perCallSystem = estimateTokens(systemChars);
  const overhead = o.backend === 'claude' ? CLAUDE_OVERHEAD_TOKENS : 0;
  const inputTokens = estimateTokens(userChars) + n * (perCallSystem + overhead);
  const outputTokens = n * EST_OUTPUT_TOKENS;
  const price = o.backend === 'claude' ? priceOf(o.model) : null;
  return {
    backend: o.backend,
    model: o.model,
    totalTasks: o.totalTasks,
    judgedAlready: o.judgedAlready,
    tasks: n,
    systemTokens: perCallSystem,
    inputTokens,
    outputTokens,
    ...(price ? { costUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000 } : {}),
    priceKnown: o.backend !== 'claude' || price !== null,
  };
}
