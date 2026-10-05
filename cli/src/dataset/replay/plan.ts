// The plan printed before anything is spent: tasks x ladder x samples, an estimated cost range, which account pays.

import type { Candidate, ReplayConfig } from './types.ts';

export type Account = 'api-key' | 'subscription' | 'cloud';

// ANTHROPIC_API_KEY present: `claude -p` bills the API (real money). Bedrock/Vertex: the cloud account. Otherwise the subscription limit.
export function detectAccount(env: Record<string, string | undefined>): Account {
  if (env.ANTHROPIC_API_KEY) return 'api-key';
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) return 'cloud';
  return 'subscription';
}

export const DEFAULT_DAILY_RUNS_SUBSCRIPTION = 40; // spec 2.1.6: without an API key, a daily cap on runs

export interface Plan {
  tasks: number;
  ladder: string[];
  samples: number;
  maxRuns: number; // tasks x ladder x samples
  lowUsd: number; // every task passes on the first configuration
  highUsd: number; // every task climbs the whole ladder, all samples run
  perConfigUsd: Record<string, number>; // all tasks x samples, per configuration
  budgetUsd: number;
  exceedsBudget: boolean;
  account: Account;
  withTests: number; // tasks with a recorded test command
  originalEdited: number;
  dailyCap?: number;
}

export function buildPlan(o: {
  candidates: readonly Candidate[];
  ladder: readonly ReplayConfig[];
  samples: number;
  budgetUsd: number;
  env: Record<string, string | undefined>;
  judgePerRunUsd?: number;
  dailyCap?: number;
}): Plan {
  const extra = o.judgePerRunUsd ?? 0;
  const perConfig: Record<string, number> = Object.fromEntries(o.ladder.map((c) => [c.id, 0]));
  let low = 0;
  for (const c of o.candidates) {
    o.ladder.forEach((cfg, idx) => {
      const run = (c.estUsd[cfg.id] ?? 0) + (c.originalEdited ? extra : 0);
      perConfig[cfg.id]! += run * o.samples;
      if (idx === 0) low += run * o.samples;
    });
  }
  const high = Object.values(perConfig).reduce((a, b) => a + b, 0);
  const account = detectAccount(o.env);
  return {
    tasks: o.candidates.length,
    ladder: o.ladder.map((c) => c.id),
    samples: o.samples,
    maxRuns: o.candidates.length * o.ladder.length * o.samples,
    lowUsd: low,
    highUsd: high,
    perConfigUsd: perConfig,
    budgetUsd: o.budgetUsd,
    exceedsBudget: high > o.budgetUsd,
    account,
    withTests: o.candidates.filter((c) => c.testCommand).length,
    originalEdited: o.candidates.filter((c) => c.originalEdited).length,
    ...(account === 'api-key' || o.dailyCap === undefined ? {} : { dailyCap: o.dailyCap }),
  };
}
