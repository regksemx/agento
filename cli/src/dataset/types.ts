// One line of `tasks.jsonl`. Field-by-field documentation: docs/dataset-schema.md.

import type { TaskEffort, TaskTier, TaskVerdict } from '../../../plugin/core/task.ts';

export const SCHEMA_VERSION = 1;

export type StartKind = 'first-prompt' | 'compact' | 'clear' | 'idle';

export interface TaskContext {
  contextTokensAtStart: number; // prefix of the first main call of the task
  startKind: StartKind;
  languages: string[]; // top 3 by files touched
  hasGitBranch: boolean;
  prevTaskWasHeavy: boolean; // the previous task of the same session got l0Tier "opus"
}

// What actually happened. Never a label: it describes the choice the human made and the trajectory it produced.
export interface TaskObserved {
  model: string; // dominant main model id
  modelTier: string; // haiku | sonnet | opus | fable | unknown
  effort?: string;
  mainCalls: number;
  subagentCalls: number;
  subagentTypes: string[];
  filesEdited: number;
  linesChanged: number;
  toolErrors: number;
  testRuns: number;
  testFailures: number;
  sameEditRepeats: number;
  userCorrections: number;
  userInterrupts: number;
  planMode: boolean;
  durationMs: number;
  outputTokens: number;
  cost: number; // USD, API-equivalent
}

export interface TaskRecord {
  v: typeof SCHEMA_VERSION;
  taskId: string;
  project: string;
  startTs: number;
  text: string[]; // scrubbed human prompts: the first one, then up to 3 follow-ups
  context: TaskContext;
  observed: TaskObserved;
  difficulty: number; // 0..1
  l0Tier: TaskTier;
  l0Effort: TaskEffort;
  rulesVerdict: TaskVerdict;
  labelSource: 'L0';
  // l1 / l2 are absent until `dataset judge` / `dataset replay` add them.
}
