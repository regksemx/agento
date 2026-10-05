// The trained classifier (`agento-brain`, spec T36/T37) as a `TaskClassifier`: what to send it, how to read its answer,
// and when to give the answer up for the local rules. Pure TypeScript: the transport (a unix-socket call with a hard
// timeout) is handed in by the mod, so nothing here touches `$`. Fail-open (P5): whatever goes wrong, the verdict is
// the one `classifyRules` gives.

import { extractFeatures, classifyRules, RULES_ID, type StartKind, type TaskClassifier, type TaskContext, type TaskEffort, type TaskStartReason, type TaskTier, type TaskVerdict } from './task.ts';

// The longest the mod waits for the daemon: a round trip is a few ms, so this is only ever spent when it is stuck.
export const BRAIN_TIMEOUT_MS = 400;
// A daemon that did not answer is not asked again for this long.
export const BRAIN_REPROBE_MS = 5 * 60_000;

export function parseBrainTimeout(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 20 && n <= 5000 ? Math.round(n) : BRAIN_TIMEOUT_MS;
}

export type BrainMode = 'auto' | 'off';
export const parseBrainMode = (v: unknown): BrainMode => (v === 'off' ? 'off' : 'auto');

// `$AGENTO_HOME/brain.sock`; AGENTO_HOME defaults to `~/.agento`. Null when neither is known.
export function brainSocketPath(override: unknown, agentoHome: string | undefined, home: string | undefined): string | null {
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  if (agentoHome && agentoHome.trim() !== '') return `${agentoHome.replace(/\/+$/, '')}/brain.sock`;
  if (home && home.trim() !== '') return `${home.replace(/\/+$/, '')}/.agento/brain.sock`;
  return null;
}

// The training vocabulary (training/README.md): `session` / `clear` (a compaction too) / `cold`.
export function startKindOf(reason: TaskStartReason): StartKind {
  if (reason === 'first-prompt') return 'session';
  if (reason === 'clear' || reason === 'compact') return 'clear';
  return 'cold';
}

// ───────────────────────── /v1/route ─────────────────────────

export function buildRouteBody(prompt: string, ctx: TaskContext, lang: string): string {
  const context: Record<string, unknown> = {
    lang,
    contextTokens: Math.max(0, Math.round(ctx.contextTokens)),
    startKind: ctx.startKind ?? (ctx.isSessionStart ? 'session' : 'cold'),
  };
  if (ctx.languages && ctx.languages.length > 0) context.repo = [...ctx.languages];
  return JSON.stringify({ text: prompt, context });
}

export interface RouteAnswer {
  tier: TaskTier;
  effort: TaskEffort;
  planFirst: boolean;
  delegateExplore: boolean;
  confidence: number;
  abstain: boolean;
  latencyMs: number | null;
  runId: string;
}

const TIERS: readonly string[] = ['haiku', 'sonnet', 'opus'];
const EFFORTS: readonly string[] = ['low', 'medium', 'high'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Null for anything that is not a well-formed answer. A tier the plugin has no word for (`fable`) is not one; an
// effort above `high` (`xhigh`) is `high`, the plugin's own top for a task's setup.
export function parseRoute(text: string): RouteAnswer | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  const { tier, effort, confidence, model_run_id: runId } = j;
  if (typeof tier !== 'string' || !TIERS.includes(tier)) return null;
  if (typeof effort !== 'string') return null;
  const e = effort === 'xhigh' ? 'high' : effort;
  if (!EFFORTS.includes(e)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (typeof runId !== 'string' || runId === '') return null;
  const flag = (v: unknown): boolean => v === true;
  return {
    tier: tier as TaskTier,
    effort: e as TaskEffort,
    planFirst: flag(j.plan_first),
    delegateExplore: flag(j.delegate_explore),
    confidence,
    abstain: j.abstain === true,
    latencyMs: typeof j.latency_ms === 'number' && Number.isFinite(j.latency_ms) ? j.latency_ms : null,
    runId,
  };
}

// The verdict of an answer worth using, or the reason it is not: the daemon abstained, or it is only serving
// the rules (which the plugin runs itself, with no round trip to explain).
export function verdictFromRoute(a: RouteAnswer): TaskVerdict | { skip: 'abstain' | 'rules-v1' } {
  if (a.runId === RULES_ID) return { skip: 'rules-v1' };
  if (a.abstain) return { skip: 'abstain' };
  const reasons = [`brain ${a.runId}: ${a.tier}·${a.effort} (${Math.round(a.confidence * 100)}%)`];
  if (a.planFirst) reasons.push('plan first');
  if (a.delegateExplore) reasons.push('delegate exploring');
  return {
    tier: a.tier,
    effort: a.effort,
    confidence: a.confidence,
    reasons,
    classifier: `brain:${a.runId}`,
    planFirst: a.planFirst,
    delegateExplore: a.delegateExplore,
    ...(a.latencyMs !== null ? { latencyMs: a.latencyMs } : {}),
  };
}

// ───────────────────────── /healthz ─────────────────────────

export interface BrainHealth {
  runId: string;
  backend: string | null;
  p50Ms: number | null;
}

export function parseHealth(text: string): BrainHealth | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j) || j.ok !== true || typeof j.model_run_id !== 'string' || j.model_run_id === '') return null;
  return {
    runId: j.model_run_id,
    backend: typeof j.backend === 'string' ? j.backend : null,
    p50Ms: typeof j.p50_ms === 'number' && Number.isFinite(j.p50_ms) ? j.p50_ms : null,
  };
}

// ───────────────────────── the classifier ─────────────────────────

export type BrainCall = { ok: true; text: string } | { ok: false; reason: string };

export interface BrainClassifierOptions {
  // Sends the request body to `/v1/route` within the mod's timeout; never throws (a throw counts as `error`).
  call: (body: string) => Promise<BrainCall>;
  // What answers when the daemon cannot (the local rules).
  fallback: TaskClassifier;
}

export function createBrainClassifier(o: BrainClassifierOptions): TaskClassifier {
  const rules = (prompt: string, ctx: TaskContext, why: string): Promise<TaskVerdict> =>
    o.fallback.classify(prompt, ctx).then((v) => ({ ...v, classifier: v.classifier ?? RULES_ID, fallback: why }));
  return {
    async classify(prompt, ctx) {
      let res: BrainCall;
      try {
        // The language the daemon is told is the one the rules measure: the same words the model was trained on.
        res = await o.call(buildRouteBody(prompt, ctx, extractFeatures(prompt, ctx).promptLang));
      } catch {
        return rules(prompt, ctx, 'error');
      }
      if (!res.ok) return rules(prompt, ctx, res.reason);
      const answer = parseRoute(res.text);
      if (!answer) return rules(prompt, ctx, 'invalid');
      const v = verdictFromRoute(answer);
      if ('skip' in v) return v.skip === 'abstain' ? withHeads(await rules(prompt, ctx, v.skip), answer) : rules(prompt, ctx, v.skip);
      return v;
    },
  };
}

// An abstaining daemon gives up only the tier and effort: its yes/no heads are calibrated on their own and are kept
// over the rules' verdict (training/artifacts: plan_first 92%, delegate_explore 76% on the held-out tasks).
export function withHeads(v: TaskVerdict, a: RouteAnswer): TaskVerdict {
  const reasons = [...v.reasons];
  if (a.planFirst) reasons.push(`brain ${a.runId}: plan first`);
  if (a.delegateExplore) reasons.push(`brain ${a.runId}: delegate exploring`);
  return { ...v, reasons, planFirst: a.planFirst, delegateExplore: a.delegateExplore, ...(a.latencyMs !== null ? { latencyMs: a.latencyMs } : {}) };
}

// The same rules, as the mod runs them at a prompt with no daemon to ask.
export function localVerdict(prompt: string, ctx: TaskContext, fallback?: string): TaskVerdict {
  return { ...classifyRules(extractFeatures(prompt, ctx)), classifier: RULES_ID, ...(fallback ? { fallback } : {}) };
}
