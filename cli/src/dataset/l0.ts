// L0 weak labels: a transparent heuristic over the observed trajectory. It measures how hard the task turned out to be,
// not what would have been sufficient. Thresholds are placeholders to be calibrated against L2 replays
// (docs/spec-phase-2-training.md §2). Every number lives in L0_THRESHOLDS and is documented in docs/dataset-schema.md.

import type { TaskEffort, TaskTier } from '../../../plugin/core/task.ts';
import type { TaskObserved } from './types.ts';

export const L0_THRESHOLDS = {
  // haiku: a question or lookup that needed no edits and went smoothly
  haiku: { maxMainCalls: 3, maxFilesEdited: 0, maxLinesChanged: 0, maxErrors: 0, maxPromptChars: 600 },
  // opus: any one of these signals
  opus: { minMainCalls: 40, minFilesEdited: 8, minCorrections: 2, planMode: true, minTestFailures: 3 },
  // effort for sonnet-tier tasks (haiku -> low, opus -> high)
  effort: { lowMaxMainCalls: 8, lowMaxFilesEdited: 2, highMinMainCalls: 20, highMinFilesEdited: 4, highMinErrors: 5 },
  // difficulty = sum of weight * min(1, value / saturation); weights sum to 1
  difficulty: {
    mainCalls: { weight: 0.3, saturation: 40 },
    filesEdited: { weight: 0.2, saturation: 8 },
    linesChanged: { weight: 0.1, saturation: 500 },
    corrections: { weight: 0.15, saturation: 2 },
    errors: { weight: 0.1, saturation: 6 }, // toolErrors + testFailures
    planMode: { weight: 0.1 },
    subagentCalls: { weight: 0.05, saturation: 10 },
  },
} as const;

const QUESTION_START_RE =
  /^\s*(?:что|как|где|почему|зачем|какой|какая|какие|какое|сколько|когда|кто|покажи|найди|объясни|расскажи|посмотри|скажи|what|how|where|why|which|when|who|show|find|list|explain|tell|look|is there|are there|does|do you|can you)(?![\p{L}\p{N}_])/iu;

// A question or lookup: the prompt is short and either asks (`?`) or starts with a question/lookup word.
export function isLookupPrompt(prompt: string): boolean {
  if (prompt.length > L0_THRESHOLDS.haiku.maxPromptChars) return false;
  return prompt.includes('?') || QUESTION_START_RE.test(prompt);
}

export interface L0Label {
  difficulty: number;
  tier: TaskTier;
  effort: TaskEffort;
}

const sat = (value: number, saturation: number): number => Math.min(1, Math.max(0, value) / saturation);

export function difficultyScore(o: TaskObserved): number {
  const d = L0_THRESHOLDS.difficulty;
  const score =
    d.mainCalls.weight * sat(o.mainCalls, d.mainCalls.saturation) +
    d.filesEdited.weight * sat(o.filesEdited, d.filesEdited.saturation) +
    d.linesChanged.weight * sat(o.linesChanged, d.linesChanged.saturation) +
    d.corrections.weight * sat(o.userCorrections, d.corrections.saturation) +
    d.errors.weight * sat(o.toolErrors + o.testFailures, d.errors.saturation) +
    (o.planMode ? d.planMode.weight : 0) +
    d.subagentCalls.weight * sat(o.subagentCalls, d.subagentCalls.saturation);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

export function l0Label(o: TaskObserved, firstPrompt: string): L0Label {
  const t = L0_THRESHOLDS;
  const difficulty = difficultyScore(o);

  const opus =
    o.mainCalls >= t.opus.minMainCalls ||
    o.filesEdited >= t.opus.minFilesEdited ||
    o.userCorrections >= t.opus.minCorrections ||
    (t.opus.planMode && o.planMode) ||
    o.testFailures >= t.opus.minTestFailures;
  if (opus) return { difficulty, tier: 'opus', effort: 'high' };

  const haiku =
    o.mainCalls <= t.haiku.maxMainCalls &&
    o.filesEdited <= t.haiku.maxFilesEdited &&
    o.linesChanged <= t.haiku.maxLinesChanged &&
    o.toolErrors <= t.haiku.maxErrors &&
    isLookupPrompt(firstPrompt);
  if (haiku) return { difficulty, tier: 'haiku', effort: 'low' };

  const e = t.effort;
  const clean = o.toolErrors === 0 && o.userCorrections === 0;
  let effort: TaskEffort = 'medium';
  if (o.mainCalls <= e.lowMaxMainCalls && o.filesEdited <= e.lowMaxFilesEdited && clean) effort = 'low';
  else if (o.mainCalls >= e.highMinMainCalls || o.filesEdited >= e.highMinFilesEdited || o.toolErrors >= e.highMinErrors || o.userCorrections >= 1) effort = 'high';
  return { difficulty, tier: 'sonnet', effort };
}
