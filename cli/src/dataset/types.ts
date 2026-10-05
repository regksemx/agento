// One line of `tasks.jsonl`. Field-by-field documentation: docs/dataset-schema.md.

import type { TaskEffort, TaskTier, TaskVerdict } from '../../../plugin/core/task.ts';

export const SCHEMA_VERSION = 1;

export type StartKind = 'first-prompt' | 'compact' | 'clear' | 'idle' | 'agent-step'; // 'agent-step': a later step of an agent run (public data only)

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

// A record of a public dataset (`agento dataset import twinrouterbench`). It carries the same identity and context fields as a
// TaskRecord, but no observed trajectory (there is no Claude Code history behind it) and no L0 fields. The label is a verified
// tier from the dataset's own protocol, mapped to ours (`l2Tier`), and the unit is one routed STEP, not a whole task.
export interface PublicTaskRecord {
  v: typeof SCHEMA_VERSION;
  taskId: string; // first 16 hex of sha256("twinrouterbench:" + source id)
  source: 'twinrouterbench';
  project: string; // "twinrouterbench/<benchmark>"
  startTs: 0;
  text: string[]; // one element: the router-visible prefix, truncated head/tail
  context: TaskContext;
  labelSource: 'L2-public';
  l2Tier: TaskTier;
  l2Evidence: PublicEvidence;
}

export interface PublicEvidence {
  publicTier: string; // the dataset's own tier: low | mid | mid_high | high
  publicTierId: number; // 0..3
  benchmark: string; // swebench | bfcl | mtrag | qmsum | pinchbench
  scenario: string;
  instanceId: string;
  stepIndex: number;
  totalSteps: number;
  benchmarkSubset?: string;
  pipelineStage: string; // ground_truth_ready | degradation_search_done | mixed_model_validated
  sourceId: string; // the original record id
  prefixChars: number; // length of the rendered prefix before truncation
  truncated: boolean;
  messages: number;
}

export type JudgeTask = TaskRecord | PublicTaskRecord;

export function isPublicTask(t: JudgeTask): t is PublicTaskRecord {
  return (t as PublicTaskRecord).source === 'twinrouterbench';
}
