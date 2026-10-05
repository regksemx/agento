// L2 replay: shared types. Field-by-field documentation of the output files: docs/dataset-schema.md (section L2).
// Nothing here ever holds prompt text on disk: records carry task ids, configurations, check results, cost, turns, duration.

import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';
import { JUDGE_CONFIGS } from '../judge/types.ts';

export const REPLAY_SCHEMA_VERSION = 1;

export interface ReplayConfig {
  id: string; // "<tier>-<effort>", the same ids as the L1 judge uses
  tier: TaskTier;
  effort: TaskEffort;
}

export const DEFAULT_LADDER: readonly ReplayConfig[] = JUDGE_CONFIGS.map((c) => ({ id: c.id, tier: c.tier, effort: c.effort }));
export const FALLBACK_CONFIG: ReplayConfig = { id: 'opus-medium', tier: 'opus', effort: 'medium' };

export const TIERS: readonly TaskTier[] = ['haiku', 'sonnet', 'opus'];
export const EFFORTS: readonly TaskEffort[] = ['low', 'medium', 'high'];

// "haiku-low,sonnet·medium, Sonnet High" -> configurations, cheapest first as given. Throws on anything unknown.
export function parseLadder(spec: string): ReplayConfig[] {
  const out: ReplayConfig[] = [];
  for (const raw of spec.split(',')) {
    const part = raw.trim().toLowerCase();
    if (part === '') continue;
    const m = /^([a-z]+)[\s·_.-]+([a-z]+)$/.exec(part);
    const tier = m?.[1] as TaskTier | undefined;
    const effort = m?.[2] as TaskEffort | undefined;
    if (!m || !tier || !effort || !TIERS.includes(tier) || !EFFORTS.includes(effort)) {
      throw new Error(`--ladder: cannot read "${raw.trim()}" (expected <haiku|sonnet|opus>-<low|medium|high>, comma separated)`);
    }
    const id = `${tier}-${effort}`;
    if (out.some((c) => c.id === id)) throw new Error(`--ladder: "${id}" appears twice`);
    out.push({ id, tier, effort });
  }
  if (out.length === 0) throw new Error('--ladder: no configurations');
  return out;
}

export type CheckState = 'pass' | 'fail' | 'skipped' | 'unavailable' | 'error';

export interface RunChecks {
  tests: CheckState; // the recorded test command; unavailable when it already fails before the replay (deps not installed)
  diff: CheckState; // `git diff` is not empty, for tasks that edited files
  judge: CheckState; // --judge-diff
}

export type RunStatus = 'ok' | 'timeout' | 'error';

// One `claude -p` run on one configuration and its verification. One line of runs.jsonl.
export interface RunRecord {
  v: typeof REPLAY_SCHEMA_VERSION;
  taskId: string;
  ts: number;
  config: string; // ReplayConfig.id
  tier: TaskTier;
  effort: TaskEffort;
  sample: number; // 1-based
  status: RunStatus; // ok: claude answered with a result; timeout: killed; error: nothing usable (infrastructure, not a verdict)
  agentError?: string; // result.subtype when claude itself reported is_error (turn cap, budget cap, ...)
  error?: string; // short reason for status error/timeout
  checks: RunChecks;
  pass: boolean;
  costUsd: number; // claude run (API-equivalent)
  judgeCostUsd?: number;
  numTurns: number;
  durationMs: number;
  diffFiles?: number;
  diffLines?: number;
}

export interface LadderStep {
  config: string;
  samples: number; // samples run (or reused) for this configuration
  passed: number;
  pass: boolean;
  reused?: boolean; // every sample came from an earlier run of this file
}

export interface L2Evidence {
  passedConfig: string | null; // null: no configuration passed, the label is the fallback
  steps: LadderStep[];
  testCommand?: string; // the recorded verification command (never prompt text)
  testBaseline?: 'pass' | 'fail'; // did the test command pass on the starting commit before the replay
  checks: Array<keyof RunChecks>; // checks that were actually evaluated for this task
  commit: string; // starting commit, full sha
  samples: number;
}

// One line of labels.jsonl: the final L2 label of a task.
export interface LabelRecord {
  v: typeof REPLAY_SCHEMA_VERSION;
  taskId: string;
  ts: number;
  l2Tier: TaskTier;
  l2Effort: TaskEffort;
  l2Evidence: L2Evidence;
  costUsd: number; // all runs of the task (this and earlier runs of the same file)
}

// Everything `replay` needs to know about a task beyond tasks.jsonl, rebuilt from the local transcripts.
export interface TaskSource {
  taskId: string;
  sessionId: string;
  projectDir: string; // directory name under the projects dir
  cwd?: string;
  gitBranch?: string;
  startTs: number;
  windowEnd: number;
  prompts: Array<{ uuid: string; text: string; truncated: boolean }>; // human prompts of the task window, raw
  edits: Array<{ ts: number; tool: string; path: string; oldString?: string }>; // Edit/Write/MultiEdit of the task, in order
  editToolUseIds: string[]; // main-line Edit/Write/MultiEdit tool_use ids (full inputs are re-read from the raw transcript)
  priorTouched: Array<{ path: string; ts: number }>; // files the session had modified before the task started
  repricedUsd: Record<TaskTier, number>; // the task's tokens (all lineages) priced as each tier
}

export type SkipReason =
  | 'already-labeled'
  | 'no-source' // the task is not in the local transcripts any more
  | 'multi-prompt' // a follow-up that is not a bare confirmation
  | 'no-cwd'
  | 'cwd-missing'
  | 'not-a-repo'
  | 'no-branch'
  | 'branch-missing'
  | 'no-commit'
  | 'stale-commit'
  | 'dirty-start'
  | 'no-verification'; // the original task edited no files: a replay that changes nothing passes every check, so it proves nothing

export const SKIP_REASONS: readonly SkipReason[] = [
  'already-labeled',
  'no-source',
  'multi-prompt',
  'no-cwd',
  'cwd-missing',
  'not-a-repo',
  'no-branch',
  'branch-missing',
  'no-commit',
  'stale-commit',
  'dirty-start',
  'no-verification',
];

export type VerificationKind = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pytest' | 'go' | 'cargo' | 'gradle' | 'maven';

export interface TestCommand {
  kind: VerificationKind;
  command: string; // run with `sh -c` from the replay directory
}

export interface Candidate {
  taskId: string;
  project: string; // scrubbed label from tasks.jsonl
  repoRoot: string;
  relCwd: string; // cwd relative to the repo root ("" for the root)
  branch: string;
  commit: string;
  commitTs: number;
  dirtyStart: boolean;
  dirtyReasons: string[];
  testCommand?: TestCommand;
  originalEdited: boolean; // the original task edited files
  l1Cheaper: boolean; // L1 (judge file) says cheaper than what ran
  estUsd: Record<string, number>; // per configuration id, with the safety factor applied
}
