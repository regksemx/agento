// Routing after the first steps of a task: what the main thread's own trajectory says about how big the task is.
// Pure TypeScript: the mod feeds it the main lineage's tool calls and steps and shows what it answers.
// Principles it keeps: P1 (the main model of a running task is never switched by this: the answer only picks the model
// of subagents spawned later and offers a suggestion the person decides on) and P3 (only downward, never above the
// user's model, and the prompt's verdict is only ever confirmed or lowered).

import { switchPenalty, type LineageState } from './cache.ts';
import { repriceAs } from './cost.ts';
import { DEFAULT_TASK_STEPS, REFERENCE_STEP, handoffSaving } from './estimate.ts';
import { isTestCommand } from './loop-guard.ts';
import { modelIdForTier, tierOf, tierRank, type Tier } from './pricing.ts';
import type { Mode } from './spawn-policy.ts';
import { confidenceThreshold } from './suggest.ts';
import type { TaskVerdict } from './task.ts';

// Every number that decides a verdict, in one place so it can be tuned.
export const TRAJECTORY_LIMITS = {
  // The checkpoint: this many main steps, or the first edit if that comes sooner.
  checkpointSteps: 4,
  // small: few files, a few mechanical edits, nothing went wrong.
  smallFiles: 4,
  smallEdits: 4,
  smallEditedFiles: 2,
  smallEditChars: 4000,
  smallOutputTokens: 6000,
  // large: any one of these.
  largeFiles: 8,
  largeErrors: 3,
  largeErrorStreak: 2,
  largeFailingTests: 2,
  largeOutputTokens: 10_000,
  // New input (not cache reads) the task has put through the model.
  largeInputTokens: 250_000,
  // A handoff is worth offering after this much exploring without an edit, with this much context to carry.
  handoffReads: 4,
  handoffPrefixTokens: 40_000,
  // Steps a small task is expected to have left, never fewer than this.
  minRemainingSteps: 3,
  // File paths kept per list: the count past this is not needed.
  maxFiles: 24,
} as const;

export interface TrajectoryStats {
  // Main-thread model requests of the task.
  steps: number;
  reads: number;
  searches: number;
  filesRead: string[];
  edits: number;
  filesEdited: string[];
  // Characters the edits wrote: how big the changes are.
  editChars: number;
  toolErrors: number;
  // Tool errors in a row, ending now.
  errorStreak: number;
  failingTests: number;
  // Tokens of new input (input plus cache writes, not cache reads) and of output, summed over the steps.
  inputTokens: number;
  outputTokens: number;
  hasEdit: boolean;
}

export function emptyTrajectory(): TrajectoryStats {
  return { steps: 0, reads: 0, searches: 0, filesRead: [], edits: 0, filesEdited: [], editChars: 0, toolErrors: 0, errorStreak: 0, failingTests: 0, inputTokens: 0, outputTokens: 0, hasEdit: false };
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const files = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, TRAJECTORY_LIMITS.maxFiles) : []);

// State a version without trajectories persisted (or a damaged one) reads as a task with nothing seen yet.
export function normalizeTrajectory(v: unknown): TrajectoryStats {
  if (!v || typeof v !== 'object') return emptyTrajectory();
  const o = v as Record<string, unknown>;
  const edits = count(o.edits);
  return {
    steps: count(o.steps),
    reads: count(o.reads),
    searches: count(o.searches),
    filesRead: files(o.filesRead),
    edits,
    filesEdited: files(o.filesEdited),
    editChars: count(o.editChars),
    toolErrors: count(o.toolErrors),
    errorStreak: count(o.errorStreak),
    failingTests: count(o.failingTests),
    inputTokens: count(o.inputTokens),
    outputTokens: count(o.outputTokens),
    hasEdit: o.hasEdit === true || edits > 0,
  };
}

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// A failing run the tool did not flag as an error: the runner's own summary line.
const FAILED_SUMMARY_RE = /\b[1-9]\d*\s+(?:failed|failing|failures?)\b/i;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function fileOf(input: Record<string, unknown>): string {
  return (str(input.file_path) || str(input.path) || str(input.notebook_path)).slice(0, 240);
}

function withFile(list: readonly string[], file: string): string[] {
  if (!file || list.includes(file) || list.length >= TRAJECTORY_LIMITS.maxFiles) return [...list];
  return [...list, file];
}

// Characters an edit tool call writes: a Write's content, an Edit's new text, each of a MultiEdit's.
function writtenChars(tool: string, input: Record<string, unknown>): number {
  if (tool === 'Write') return str(input.content).length;
  if (tool === 'NotebookEdit') return str(input.new_source).length;
  const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : [input];
  let n = 0;
  for (const ed of edits) if (ed && typeof ed === 'object') n += str((ed as Record<string, unknown>).new_string).length;
  return n;
}

export interface TrajectoryToolCall {
  tool: string;
  input: unknown;
  isError: boolean;
  text?: string;
}

// One main-thread tool call.
export function foldToolCall(prev: TrajectoryStats, c: TrajectoryToolCall): TrajectoryStats {
  const s = normalizeTrajectory(prev);
  const input = c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : {};
  const out: TrajectoryStats = { ...s, toolErrors: s.toolErrors + (c.isError ? 1 : 0), errorStreak: c.isError ? s.errorStreak + 1 : 0 };
  if (READ_TOOLS.has(c.tool)) {
    out.reads += 1;
    out.filesRead = withFile(s.filesRead, fileOf(input));
  } else if (SEARCH_TOOLS.has(c.tool)) {
    out.searches += 1;
  } else if (EDIT_TOOLS.has(c.tool)) {
    out.edits += 1;
    out.hasEdit = true;
    out.filesEdited = withFile(s.filesEdited, fileOf(input));
    out.editChars += writtenChars(c.tool, input);
  } else if (c.tool === 'Bash') {
    const command = str(input.command);
    if (command && isTestCommand(command) && (c.isError || FAILED_SUMMARY_RE.test(c.text ?? ''))) out.failingTests += 1;
  }
  return out;
}

export interface TrajectoryUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
}

// One main-thread model request.
export function foldStep(prev: TrajectoryStats, u: TrajectoryUsage): TrajectoryStats {
  const s = normalizeTrajectory(prev);
  return { ...s, steps: s.steps + 1, inputTokens: s.inputTokens + count(u.input_tokens) + count(u.cache_creation_input_tokens), outputTokens: s.outputTokens + count(u.output_tokens) };
}

export const filesTouched = (s: TrajectoryStats): number => new Set([...s.filesRead, ...s.filesEdited]).size;

export function checkpointReached(s: TrajectoryStats): boolean {
  return s.steps >= TRAJECTORY_LIMITS.checkpointSteps || (s.hasEdit && s.steps >= 1);
}

export type Complexity = 'small' | 'medium' | 'large';

export interface MainDowngrade {
  to: 'sonnet';
  // Steps the cache rewrite takes to pay back at the cheaper price (an estimate).
  breakEvenSteps: number;
  // The one-time cost of the target model writing the prefix the current model now reads, and what each step saves.
  penaltyUsd: number;
  perStepUsd: number;
  // What the rest of the task is expected to save, net of the rewrite.
  savingUsd: number;
}

export interface TrajectoryVerdict {
  complexity: Complexity;
  // The ceiling for the model of subagents spawned later in this task, or null to leave them to the spawn policy.
  spawnTier: Tier | null;
  // Writing the code from a clean context on Sonnet would pay: a plan to hand over, a long conversation to leave behind.
  handoff: boolean;
  handoffSavingUsd: number | null;
  mainDowngrade: MainDowngrade | null;
  reasons: string[];
}

export interface TrajectoryFacts {
  stats: TrajectoryStats;
  // What was decided from the prompt at the task's start (the brain's or the rules'), if anything.
  promptVerdict: Pick<TaskVerdict, 'tier' | 'confidence'> & Partial<Pick<TaskVerdict, 'planFirst'>> | null;
  // The model and effort the task is running on.
  current: { model: string; effort: string | null };
  // The main conversation's cache as of its last step.
  cache: LineageState | undefined;
  now: number;
  mode: Mode;
  // A verdict was already given for this task.
  alreadyDecided: boolean;
}

// What one request costs on `model` with a prefix of `tokens` read from the cache.
function stepCostWithPrefix(model: string, tokens: number): number | null {
  return repriceAs(model, { ...REFERENCE_STEP, cache_read_input_tokens: tokens })?.total ?? null;
}

function complexityOf(s: TrajectoryStats, reasons: string[]): Complexity {
  const L = TRAJECTORY_LIMITS;
  const touched = filesTouched(s);
  const large: string[] = [];
  if (touched >= L.largeFiles) large.push(`files: ${touched}`);
  if (s.toolErrors >= L.largeErrors) large.push(`errors: ${s.toolErrors}`);
  else if (s.errorStreak >= L.largeErrorStreak) large.push(`error streak: ${s.errorStreak}`);
  if (s.failingTests >= L.largeFailingTests) large.push(`failing tests: ${s.failingTests}`);
  if (s.outputTokens >= L.largeOutputTokens) large.push(`output tokens: ${s.outputTokens}`);
  if (s.inputTokens >= L.largeInputTokens) large.push(`input tokens: ${s.inputTokens}`);
  if (large.length > 0) {
    reasons.push(...large);
    return 'large';
  }
  const small =
    s.hasEdit &&
    s.toolErrors === 0 &&
    s.failingTests === 0 &&
    touched <= L.smallFiles &&
    s.edits <= L.smallEdits &&
    s.filesEdited.length <= L.smallEditedFiles &&
    s.editChars <= L.smallEditChars &&
    s.outputTokens <= L.smallOutputTokens;
  reasons.push(`files: ${touched}`);
  if (s.hasEdit) reasons.push(`edits: ${s.edits}`);
  else reasons.push('no edits yet');
  if (small) {
    reasons.push('no errors');
    return 'small';
  }
  if (s.toolErrors > 0) reasons.push(`errors: ${s.toolErrors}`);
  return 'medium';
}

// Null until the checkpoint is reached, and null once a verdict was given (and in `quality` and `off`, where agento
// changes nothing). Past that it answers once per task; the caller keeps the answer.
export function decideTrajectory(f: TrajectoryFacts): TrajectoryVerdict | null {
  if (f.alreadyDecided || f.mode === 'quality' || f.mode === 'off') return null;
  const s = normalizeTrajectory(f.stats);
  if (!checkpointReached(s)) return null;

  const reasons: string[] = [];
  const complexity = complexityOf(s, reasons);
  const curTier = tierOf(f.current.model);
  const sonnet = tierRank('sonnet');
  const pv = f.promptVerdict;
  // The prompt's verdict counts when it was confident enough to have acted on; it is never raised, only kept or lowered.
  const confident = pv !== null && pv.confidence >= confidenceThreshold(f.mode);
  const out: TrajectoryVerdict = { complexity, spawnTier: null, handoff: false, handoffSavingUsd: null, mainDowngrade: null, reasons };
  if (curTier === null || complexity === 'large') return out;

  // A small task's subagents do not need more than Sonnet. Otherwise only a confident prompt verdict below the user's
  // model is carried over (never below Sonnet: the cheapest tier is the spawn policy's to give, for reading).
  const candidate: Tier | null = complexity === 'small' ? 'sonnet' : confident && pv ? (tierRank(pv.tier) < sonnet ? 'sonnet' : pv.tier) : null;
  if (candidate && tierRank(candidate) < tierRank(curTier)) {
    out.spawnTier = candidate;
    if (complexity === 'medium') reasons.push(`prompt verdict: ${candidate}`);
  }

  const prefix = f.cache?.prefixTokens ?? 0;
  if (!f.cache || prefix <= 0 || tierRank(curTier) <= sonnet) return out;

  // The prompt's own verdict was a heavier tier than Sonnet: the trajectory does not argue the main model down.
  const heavyPrompt = confident && pv !== null && tierRank(pv.tier) > sonnet;
  const L = TRAJECTORY_LIMITS;
  if (complexity === 'small' && !heavyPrompt) {
    const target = modelIdForTier('sonnet', f.current.model);
    const from = stepCostWithPrefix(f.current.model, prefix);
    const to = target ? stepCostWithPrefix(target, prefix) : null;
    const penalty = target ? switchPenalty(f.cache, target, f.now) : null;
    if (target && from !== null && to !== null && penalty !== null && from - to > 0) {
      const perStep = from - to;
      const owed = Math.max(0, penalty);
      const breakEvenSteps = Math.max(1, Math.ceil(owed / perStep));
      const remaining = Math.max(L.minRemainingSteps, DEFAULT_TASK_STEPS.light - s.steps);
      if (breakEvenSteps <= remaining) out.mainDowngrade = { to: 'sonnet', breakEvenSteps, penaltyUsd: owed, perStepUsd: perStep, savingUsd: perStep * remaining - owed };
    }
  }

  // Exploring is done, the coding is next, and the context it built is read on every step: a clean start on Sonnet.
  if (!s.hasEdit && prefix >= L.handoffPrefixTokens && (s.filesRead.length >= L.handoffReads || pv?.planFirst === true)) {
    const steps = Math.max(L.minRemainingSteps, DEFAULT_TASK_STEPS.default - s.steps);
    const saving = handoffSaving(f.current.model, 'sonnet', prefix, steps);
    if (saving !== null) {
      out.handoff = true;
      out.handoffSavingUsd = saving;
      reasons.push(`context: ${prefix}`);
    }
  }
  return out;
}
