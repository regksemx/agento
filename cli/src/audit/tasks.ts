import { costOf, repriceAs } from '../../../plugin/core/cost.ts';
import { tierOf } from '../../../plugin/core/pricing.ts';
import type { ApiCall, Corpus, SessionData, TaskSummary, TasksSection, UserPrompt } from '../types.ts';

export const IDLE_BOUNDARY_MS = 30 * 60_000;
const LIGHT_MAX_CALLS = 8;
const LIGHT_MAX_FILES = 2;
const LIGHT_MAX_OUTPUT = 6_000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface TaskSegment {
  summary: TaskSummary;
  prompt: UserPrompt;
  mainCalls: ApiCall[];
  windowCalls: ApiCall[]; // every lineage, ts in [startTs, windowEnd)
  windowEnd: number; // start of the next task, or Infinity
}

// Task starts (spec 4.4 plus idle > 30 min): the first human prompt, a prompt after a compact/clear marker,
// a prompt after more than 30 min without a main call. Slash commands never start a task.
export function taskStartPrompts(s: SessionData): UserPrompt[] {
  const mainTs = s.calls.filter((c) => c.lineage === 'main').map((c) => c.ts);
  const resets = s.markers.filter((m) => m.kind === 'compact' || m.kind === 'clear').map((m) => m.ts);
  const starts: UserPrompt[] = [];
  let prevTs: number | null = null;
  let mi = 0; // index of the last main call strictly before the current prompt
  let lastMain: number | null = null;
  for (const p of s.prompts) {
    if (p.isSlashCommand) continue;
    while (mi < mainTs.length && (mainTs[mi] as number) < p.ts) lastMain = mainTs[mi++] as number;
    const reset = prevTs !== null && resets.some((t) => t > prevTs! && t <= p.ts);
    const idle = lastMain !== null && p.ts - lastMain > IDLE_BOUNDARY_MS;
    if (prevTs === null || reset || idle) starts.push(p);
    prevTs = p.ts;
  }
  return starts;
}

function dominant<T>(counts: Map<T, number>): T | undefined {
  let best: T | undefined;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function filesTouched(calls: ApiCall[]): number {
  const files = new Set<string>();
  for (const c of calls) {
    for (const t of c.toolUses) {
      if (!EDIT_TOOLS.has(t.name) || typeof t.input !== 'object' || t.input === null) continue;
      const i = t.input as Record<string, unknown>;
      const path = i.file_path ?? i.notebook_path;
      if (typeof path === 'string' && path) files.add(path);
    }
  }
  return files.size;
}

export function segmentSession(s: SessionData): TaskSegment[] {
  const starts = taskStartPrompts(s);
  const out: TaskSegment[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const prompt = starts[i] as UserPrompt;
    const windowEnd = starts[i + 1]?.ts ?? Infinity;
    const windowCalls = s.calls.filter((c) => c.ts >= prompt.ts && c.ts < windowEnd);
    const mainCalls = windowCalls.filter((c) => c.lineage === 'main');
    if (mainCalls.length === 0) continue; // a prompt that never got an answer is not a task

    const outByModel = new Map<string, number>();
    const effortCount = new Map<string, number>();
    for (const c of mainCalls) {
      outByModel.set(c.model, (outByModel.get(c.model) ?? 0) + c.usage.output_tokens);
      if (c.effort) effortCount.set(c.effort, (effortCount.get(c.effort) ?? 0) + 1);
    }
    const outputTokens = windowCalls.reduce((n, c) => n + c.usage.output_tokens, 0);
    const filesEdited = filesTouched(windowCalls);
    const errors = s.toolResults.filter((r) => r.isError && r.ts >= prompt.ts && r.ts < windowEnd).length;
    const cost = windowCalls.reduce((n, c) => n + (costOf(c.model, c.usage)?.total ?? 0), 0);

    out.push({
      prompt,
      mainCalls,
      windowCalls,
      windowEnd,
      summary: {
        sessionId: s.sessionId,
        startTs: prompt.ts,
        endTs: (mainCalls[mainCalls.length - 1] as ApiCall).ts,
        model: dominant(outByModel) as string,
        effort: dominant(effortCount),
        mainCalls: mainCalls.length,
        filesEdited,
        outputTokens,
        errors,
        cost,
        isLight: mainCalls.length <= LIGHT_MAX_CALLS && filesEdited <= LIGHT_MAX_FILES && outputTokens <= LIGHT_MAX_OUTPUT,
        firstPrompt: prompt.text.slice(0, 200),
      },
    });
  }
  return out;
}

export function segmentTasks(s: SessionData): TaskSummary[] {
  return segmentSession(s).map((t) => t.summary);
}

export function analyzeTasks(c: Corpus): TasksSection {
  const segments = c.sessions.flatMap(segmentSession);
  const light = segments.filter((t) => t.summary.isLight);
  const onExpensive = light.filter((t) => {
    const tier = tierOf(t.summary.model);
    return tier === 'opus' || tier === 'fable';
  });
  let cost = 0;
  let asSonnet = 0;
  for (const t of onExpensive) {
    cost += t.summary.cost;
    for (const call of t.windowCalls) asSonnet += repriceAs('sonnet', call.usage)?.total ?? 0;
  }
  return {
    count: segments.length,
    light: light.length,
    lightOnExpensive: { count: onExpensive.length, cost, asSonnet },
    maxEffortOnLight: light.filter((t) => t.summary.effort === 'max' || t.summary.effort === 'xhigh').length,
    topExamples: light
      .map((t) => t.summary)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5),
  };
}
