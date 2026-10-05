// L1 judge: shared types. Field-by-field documentation of the output file: docs/dataset-schema.md (section L1).

import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';

export const JUDGE_SCHEMA_VERSION = 1;

// The configuration ladder, cheapest first. `id` is the key used in prompts, schemas and `l1Probs`.
export const JUDGE_CONFIGS = [
  { id: 'haiku-low', tier: 'haiku', effort: 'low' },
  { id: 'sonnet-medium', tier: 'sonnet', effort: 'medium' },
  { id: 'sonnet-high', tier: 'sonnet', effort: 'high' },
  { id: 'opus-medium', tier: 'opus', effort: 'medium' },
] as const satisfies ReadonlyArray<{ id: string; tier: TaskTier; effort: TaskEffort }>;

export type ConfigId = (typeof JUDGE_CONFIGS)[number]['id'];
export type JudgeProbs = Record<ConfigId, number>;

// What the judge answers for one task.
export interface JudgeVerdict {
  probs: JudgeProbs; // p(config completes the task at the same quality on the first try)
  needsPlanFirst: boolean;
  delegateExplore: boolean;
  difficulty: number; // 1..5
  rationale: string;
}

export interface JudgeLabel {
  tier: TaskTier;
  effort: TaskEffort;
}

export type JudgeBackendKind = 'openai' | 'claude';

export interface JudgeUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number; // reported by the backend (claude), API-equivalent
}

interface JudgeRecordBase {
  v: typeof JUDGE_SCHEMA_VERSION;
  taskId: string;
  ts: number; // epoch ms when the verdict was written
  judgeBackend: JudgeBackendKind;
  judgeModel: string; // model name or alias as given on the command line
  judgeModelResolved?: string; // concrete model id when the backend reports it
  promptVersion: string; // hash of the judge prompt (system + schema + user layout)
}

export interface JudgeRecordOk extends JudgeRecordBase {
  ok: true;
  threshold: number; // --threshold at the time of writing
  l1Tier: TaskTier;
  l1Effort: TaskEffort;
  l1Probs: JudgeProbs;
  l1Difficulty: number; // 1..5
  needsPlanFirst: boolean;
  delegateExplore: boolean;
  rationale: string;
  usage?: JudgeUsage;
}

export interface JudgeRecordFail extends JudgeRecordBase {
  ok: false;
  error: string;
  raw?: string; // start of the model output that could not be parsed
}

export type JudgeRecord = JudgeRecordOk | JudgeRecordFail;

// One call to a judge model.
export interface JudgePrompt {
  system: string;
  user: string;
}

export interface JudgeCompletion {
  text: string;
  usage?: JudgeUsage;
  resolvedModel?: string;
}

export interface JudgeBackend {
  kind: JudgeBackendKind;
  model: string;
  complete(prompt: JudgePrompt): Promise<JudgeCompletion>;
}

// Transport-level failure (network, HTTP status, timeout, non-zero exit). Not a bad verdict.
export class BackendError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'BackendError';
    this.retryable = retryable;
  }
}
