// The judging loop: plan which tasks still need a verdict, run them through a backend with bounded concurrency,
// append every verdict as soon as it exists (so a crash or Ctrl-C loses at most the in-flight calls).

import type { TaskRecord } from '../types.ts';
import { deriveLabel, DEFAULT_THRESHOLD } from './label.ts';
import { parseJudgeResponse } from './parse.ts';
import { buildJudgePrompt, PROMPT_VERSION } from './prompt.ts';
import { appendJudgeRecord, judgedMap, readJudgeFile } from './store.ts';
import { BackendError, JUDGE_SCHEMA_VERSION, type JudgeBackend, type JudgeRecord, type JudgeRecordOk, type JudgeUsage } from './types.ts';

export interface PlanOptions {
  force: boolean;
  maxTasks?: number;
}

export interface Plan {
  pending: TaskRecord[];
  skipped: number; // already judged and not selected again
  alreadyJudged: number;
}

// With --max-tasks the selection is a stable pseudo-random sample (taskId is a hash), not "the oldest N":
// successive runs continue the same order and the sample is not biased towards early history.
export function planRun(tasks: readonly TaskRecord[], done: ReadonlyMap<string, unknown>, o: PlanOptions): Plan {
  const alreadyJudged = tasks.filter((t) => done.has(t.taskId)).length;
  let pending = o.force ? [...tasks] : tasks.filter((t) => !done.has(t.taskId));
  if (o.maxTasks !== undefined) pending = pending.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)).slice(0, Math.max(0, o.maxTasks));
  return { pending, skipped: o.force ? 0 : alreadyJudged, alreadyJudged };
}

export interface RunOptions {
  tasks: readonly TaskRecord[];
  outPath: string;
  backend: JudgeBackend;
  threshold?: number;
  concurrency?: number;
  force?: boolean;
  maxTasks?: number;
  abortAfterTransportFailures?: number; // consecutive; the backend is considered down
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
}

export interface RunResult {
  judged: number; // ok verdicts written in this run
  skipped: number;
  failed: number; // parse failures (written as ok:false) + transport failures (not written)
  parseFailures: number;
  transportFailures: number;
  attempted: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  aborted?: string;
  staleVersion: number; // already-judged verdicts produced by a different prompt version
}

export async function runJudge(o: RunOptions): Promise<RunResult> {
  const threshold = o.threshold ?? DEFAULT_THRESHOLD;
  const now = o.now ?? Date.now;
  const existing = readJudgeFile(o.outPath);
  const done = judgedMap(existing);
  const plan = planRun(o.tasks, done, { force: Boolean(o.force), maxTasks: o.maxTasks });
  const staleVersion = [...done.values()].filter((r) => r.promptVersion !== PROMPT_VERSION).length;
  const res: RunResult = {
    judged: 0,
    skipped: plan.skipped,
    failed: 0,
    parseFailures: 0,
    transportFailures: 0,
    attempted: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    staleVersion,
  };
  const limit = o.abortAfterTransportFailures ?? 5;
  let consecutive = 0;
  let next = 0;
  let finished = 0;
  const base = { v: JUDGE_SCHEMA_VERSION, judgeBackend: o.backend.kind, judgeModel: o.backend.model, promptVersion: PROMPT_VERSION } as const;

  const work = async (): Promise<void> => {
    while (!res.aborted) {
      const i = next++;
      const task = plan.pending[i];
      if (!task) return;
      res.attempted += 1;
      try {
        const c = await o.backend.complete(buildJudgePrompt(task));
        consecutive = 0;
        if (c.usage) {
          res.usage.inputTokens += c.usage.inputTokens ?? 0;
          res.usage.outputTokens += c.usage.outputTokens ?? 0;
          res.usage.costUsd += c.usage.costUsd ?? 0;
        }
        const parsed = parseJudgeResponse(c.text);
        const resolved = c.resolvedModel ? { judgeModelResolved: c.resolvedModel } : {};
        let rec: JudgeRecord;
        if (parsed.ok) {
          const label = deriveLabel(parsed.verdict.probs, threshold);
          const usage: JudgeUsage | undefined = c.usage && Object.values(c.usage).some((x) => x !== undefined) ? c.usage : undefined;
          const ok: JudgeRecordOk = {
            ...base,
            taskId: task.taskId,
            ts: now(),
            ...resolved,
            ok: true,
            threshold,
            l1Tier: label.tier,
            l1Effort: label.effort,
            l1Probs: parsed.verdict.probs,
            l1Difficulty: parsed.verdict.difficulty,
            needsPlanFirst: parsed.verdict.needsPlanFirst,
            delegateExplore: parsed.verdict.delegateExplore,
            rationale: parsed.verdict.rationale,
            ...(usage ? { usage } : {}),
          };
          rec = ok;
          res.judged += 1;
        } else {
          rec = { ...base, taskId: task.taskId, ts: now(), ...resolved, ok: false, error: parsed.error, raw: c.text.slice(0, 300) };
          res.parseFailures += 1;
          res.failed += 1;
        }
        appendJudgeRecord(o.outPath, rec);
      } catch (e) {
        if (!(e instanceof BackendError)) throw e;
        res.transportFailures += 1;
        res.failed += 1;
        if (++consecutive >= limit) res.aborted = `backend unreachable after ${consecutive} consecutive failures: ${e.message}`;
      }
      o.onProgress?.(++finished, plan.pending.length);
    }
  };

  const workers = Math.max(1, Math.min(o.concurrency ?? 8, plan.pending.length || 1));
  await Promise.all(Array.from({ length: workers }, work));
  return res;
}
