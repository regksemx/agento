// Human labels (`agento dataset label`): the owner's hindsight verdicts on their OWN past tasks. Gold for calibration.
// Field-by-field documentation of the file: docs/dataset-schema.md (section "Human labels").

import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';

export const HUMAN_SCHEMA_VERSION = 1;
export const HUMAN_FILE = 'human.jsonl';

// One line of `$AGENTO_HOME/dataset/judge/human.jsonl`. The training export merges every `judge/*.jsonl` by taskId and reads
// `l2Tier`, `l2Effort`, `l2PlanFirst`, `l2DelegateExplore` as the L2 (gold) source, so the names are the export's, not ours.
// "Don't remember" is stored with explicit nulls: it replaces an earlier verdict of the same task instead of leaking through it.
export interface HumanRecord {
  v: typeof HUMAN_SCHEMA_VERSION;
  taskId: string;
  ok: true;
  ts: number; // epoch ms
  labelSource: 'human';
  labeledAt: string; // ISO
  labelerSeconds: number; // time from showing the card to the last answer
  unsure: boolean;
  l2Tier: TaskTier | null;
  l2Effort: TaskEffort | null;
  l2PlanFirst: boolean | null; // a strong model should have planned first
  l2DelegateExplore: boolean | null; // exploration could go to a cheap subagent
}

// What the L1 judge said about a task, reduced to what the card and the agreement metrics need.
export interface L1Guess {
  tier: TaskTier;
  effort: TaskEffort;
  planFirst?: boolean;
  delegateExplore?: boolean;
}

export const TIERS: readonly TaskTier[] = ['haiku', 'sonnet', 'opus'];
export const EFFORTS: readonly TaskEffort[] = ['low', 'medium', 'high'];
export const tierRank = (t: TaskTier): number => TIERS.indexOf(t);
