import { update } from 'claude-code';
import type { AgentSpawnInput, Hook, MatchedHook } from 'claude-code';
import { LoopGuard } from '../core/loop-guard.ts';
import { decideSpawnModel, parseMode, type Mode } from '../core/spawn-policy.ts';
import { isWarm } from '../core/cache.ts';
import { fitPctPerUsd, isCalibration, recordStep, CALIBRATION_KEY } from '../core/calibration.ts';
import { classKey, classOf, DEFAULT_TASK_STEPS, estimateSaving, foldClassStats, handoffSaving, isClassStats, readCostPerStep, stepSaving, type ClassStats, type TaskClass } from '../core/estimate.ts';
import { MAX_PLAN_CHARS, handoffPrompt, planDocument, planPath } from '../core/handoff.ts';
import { langFromEnv, orchestrateSection } from '../core/orchestrate.ts';
import { tierOf, TIER_ALIAS, type Tier } from '../core/pricing.ts';
import { canReplace, decidePrompt, dismissKeyOf, dismissStoreKey, makeOverride, overrideFor, S4_CONTEXT_TOKENS, type DismissKey, type PromptFacts } from '../core/suggest.ts';
import type { AgentoBanner, AgentoLedger, AgentoLoopSignalRecord, AgentoPaneRange, AgentoSpawnDecision, AgentoStep, AgentoTask } from '../types';
import { agentHint, autopilotBanner, autopilotToast, s1Banner, s2aBanner, s2bBanner, s4Banner, s7Banner, type BannerBase, type MoneyCtx } from './banner.ts';
import { nextMode, parseAgentoArgs, parseAutopilot, parseOnOff, type Autopilot } from './command.ts';
import {
  applyCredit,
  applyDecision,
  applyHandoff,
  applyHint,
  applySignal,
  applyStep,
  dayKey,
  dropMainLineage,
  emptyLedger,
  expiredDayKeys,
  foldDay,
  isDay,
  lineageOf,
  normalizeDay,
  type DayAggregate,
  type HintKind,
  type StepInput,
} from './ledger.ts';
import { buildPanel, foldDays, rangeDays, sessionNumbers, type PanelData, type Row, type Tone } from './panel.ts';
import { formatStatus } from './status.ts';
import type { Lang } from './strings.ts';

// All of agento's `$` code lives in this file, as named hooks: the mod validator follows `$` only
// into functions declared in the same file, so register.ts hands the hooks to `on` by name. Every
// hook is fail-open (P5): whatever agento gets wrong, the call goes on as if it were not installed.
// The pure parts (cost folding, status text, loop detection, spawn policy, what to suggest, banner text,
// the pane's rows) are in core/ and beside this file.

// `plugin` and `key` are literals: `claude plugin validate` reads them off the source.
const ledgerRef = { plugin: 'agento', key: 'ledger' } as const;
const bannerRef = { plugin: 'agento', key: 'banner' } as const;
const taskRef = { plugin: 'agento', key: 'task' } as const;
const sessionRef = { plugin: 'agento', key: 'session' } as const;
const rangeRef = { plugin: 'agento', key: 'range' } as const;

const PANE_ID = 'agento';

type Dollar = Parameters<Hook<'session.start'>>[0];

let mode: Mode = 'balanced';
let autopilot: Autopilot = 'off';
let suggestionsOn = true;
let orchestrateOn = false;
let langOption: 'ru' | 'en' | 'auto' = 'auto';
let guard = new LoopGuard();
// The id of the model turn that is running, so a banner's [Stop] can end it. Only ever used to abort.
let runningTurn: string | null = null;

// Called by register() on every (re)load, with the plugin's options.
export function configure(options: Readonly<Record<string, unknown>>): void {
  mode = parseMode(options.mode);
  autopilot = parseAutopilot(options.autopilot);
  suggestionsOn = options.suggestions !== 'off';
  orchestrateOn = parseOnOff(options.orchestrate) === 'on';
  langOption = options.lang === 'ru' || options.lang === 'en' ? options.lang : 'auto';
  guard = new LoopGuard();
}

// The model to spawn on instead of the requested one, or undefined to leave the spawn alone.
export function chooseSpawnModel(m: Mode, e: AgentSpawnInput): { model?: string; reason: string } {
  try {
    if (m === 'quality' || m === 'off') return { reason: `mode-${m}` };
    // A fork inherits the parent's cache, a teammate is a named member of the team, and an agent
    // another plugin or the user defined has chosen its own model.
    if (e.fork || e.isTeammate || (e.provider && e.provider.plugin !== 'engine')) return { reason: 'not-routable' };
    return decideSpawnModel({ subagentType: e.subagentType, requestedModel: e.model, prompt: e.prompt, parentModel: e.parentModel, mode: m });
  } catch {
    return { reason: 'error' };
  }
}

// ---- small helpers ----

// The store has no atomic update: writes to it go through one queue.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

// Gives up on a call that does not answer in time, without leaving a timer behind.
async function within<T>($: Dollar, work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: { cancel: () => void } | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = $.clock.after(ms, () => resolve(undefined));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    timer?.cancel();
  }
}

let subscription: boolean | undefined;
let pruned = false;

const emptyTask = (): AgentoTask => ({ prompts: 0, lastPrompt: '', lastPromptAt: 0, marker: null, explicitNew: false, shown: [], current: null, override: null, pendingHint: null, quiet: false });

async function langOf($: Dollar): Promise<Lang> {
  const { value } = await $.state.get(sessionRef);
  if (value?.lang) return value.lang;
  if (langOption !== 'auto') return langOption;
  return langFromEnv(await safe(() => $.env.get('LANG'), undefined));
}

async function moneyOf($: Dollar): Promise<MoneyCtx> {
  const lang = await langOf($);
  const { value: l } = await $.state.get(ledgerRef);
  const cal = await safe(() => $.store.get(CALIBRATION_KEY), undefined);
  return { lang, isSubscription: subscription ?? l?.isSubscription ?? false, pctPerUsd: isCalibration(cal) ? fitPctPerUsd(cal) : null };
}

// Adds counters to today's aggregate in $.store.
type DayCounters = Partial<Pick<DayAggregate, 'routedSpawns' | 'loopSignals' | 'hintsShown' | 'hintsAccepted' | 'hintsDismissed' | 'autopilotActions'>>;
async function bumpDay($: Dollar, ts: number, add: DayCounters): Promise<void> {
  const key = dayKey(ts);
  const d = normalizeDay(await $.store.get(key));
  const next: DayAggregate = { ...d };
  for (const k of Object.keys(add) as Array<keyof DayCounters>) next[k] = d[k] + (add[k] ?? 0);
  await $.store.set(key, next);
}

// ledger.hints and today's aggregate move together.
async function countHint($: Dollar, kind: HintKind): Promise<void> {
  try {
    const now = await $.clock.now();
    await enqueue(async () => {
      await update($, ledgerRef, (prev) => applyHint(prev, kind, now, mode, subscription ?? false));
      const field = { shown: 'hintsShown', accepted: 'hintsAccepted', dismissed: 'hintsDismissed', auto: 'autopilotActions' } as const;
      await bumpDay($, now, { [field[kind]]: 1 });
    });
  } catch {
    // counting is a convenience
  }
}

// ---- banners: one at a time, S7 > S2 > S1 > S4 ----

let bannerSeq = 0;

// Shows a banner unless a higher-priority one holds the band. Returns whether it was shown.
async function showBanner($: Dollar, spec: BannerBase, cwd: string): Promise<boolean> {
  const now = await $.clock.now();
  const { value: cur } = await $.state.get(bannerRef);
  if (cur && !canReplace(cur.scenario, spec.scenario)) return false;
  bannerSeq += 1;
  const banner: AgentoBanner = { ...spec, id: `${now}-${bannerSeq}`, ts: now, cwd };
  await update($, bannerRef, () => banner);
  await countHint($, 'shown');
  return true;
}

async function clearBanner($: Dollar, keep?: (b: AgentoBanner) => boolean): Promise<void> {
  const { value: cur } = await $.state.get(bannerRef);
  if (!cur || (keep && keep(cur))) return;
  await update($, bannerRef, () => null);
}

async function dismissedFor($: Dollar, cwd: string): Promise<DismissKey[]> {
  const out: DismissKey[] = [];
  for (const k of ['S1', 'S2', 'S4'] as const) if (await safe(() => $.store.get(dismissStoreKey(k, cwd)), undefined)) out.push(k);
  return out;
}

// ---- session ----

export const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const r = await next(e);
  try {
    // `/agento` is there even when agento is off: it is how it is turned back on.
    await $.command.register({ name: 'agento', description: 'agento: spend, savings, hints and settings', argumentHint: '[mode|autopilot|orchestrate|new] [value]' });
  } catch {
    // no command is fine
  }
  if (mode === 'off') return r;
  try {
    // Subscription: a bearer (OAuth) credential, or rate-limit windows the account reports.
    let isSub = false;
    try {
      isSub = (await $.session.authorize())?.kind === 'bearer';
    } catch {
      // no credential to hold
    }
    if (!isSub) {
      try {
        isSub = (await $.session.usage()).rateLimits.some((x) => x.kind === 'five_hour' || x.kind === 'seven_day');
      } catch {
        // no usage to read
      }
    }
    subscription = isSub;
    const now = await $.clock.now();
    // P7: what the system prompt carries is decided here, once, and read back from this value for the whole session.
    const lang: Lang = langOption !== 'auto' ? langOption : langFromEnv(await safe(() => $.env.get('LANG'), undefined));
    await update($, sessionRef, () => ({ lang, orchestrate: orchestrateOn, startedAt: now }));
    await update($, taskRef, () => emptyTask());
    await update($, bannerRef, () => null);
    await update($, rangeRef, () => 'session' as AgentoPaneRange);
    await enqueue(async () => {
      await update($, ledgerRef, (prev) => (prev ? { ...prev, mode, isSubscription: isSub } : emptyLedger(now, mode, isSub)));
    });
    // The cache clock keeps running between steps: redraw the status line and the pane once a minute.
    $.clock.every(60_000, async () => {
      try {
        const { value } = await $.state.get(ledgerRef);
        if (value && value.steps > 0) $.ui.status(formatStatus(value, await $.clock.now()));
        $.ui.invalidate('ui.render');
      } catch {
        // fine
      }
    });
  } catch {
    // fine
  }
  return r;
};

// The task in progress is over: its cost joins the averages that later estimates are made from.
async function closeTask($: Dollar): Promise<void> {
  const { value: t } = await $.state.get(taskRef);
  const cur = t?.current;
  if (!cur || cur.steps === 0 || !cur.tier) return;
  await enqueue(async () => {
    const key = classKey(cur.class as TaskClass);
    await $.store.set(key, foldClassStats(await $.store.get(key), cur.tier as Tier, cur.cost, cur.steps));
  });
}

export const onSessionEnd: Hook<'session.end'> = async ($, e, next) => {
  if (mode === 'off') return next(e);
  try {
    await closeTask($);
    // After /clear the main thread starts with an empty cache, and the next prompt is a task start (§4.4).
    if (e.reason === 'clear') {
      guard.reset();
      await update($, taskRef, (t) => ({ ...(t ?? emptyTask()), marker: 'clear' as const, current: null, override: null }));
      await update($, bannerRef, () => null);
      await enqueue(async () => {
        const { value } = await $.state.get(ledgerRef);
        if (!value?.lineages.main) return;
        const l = await update($, ledgerRef, (prev) => (prev ? dropMainLineage(prev) : value));
        $.ui.status(formatStatus(l, await $.clock.now()));
      });
    }
  } catch {
    // fine
  }
  return next(e);
};

// A compaction rewrites the conversation: the main cache starts over and the next prompt is a task start.
export const onSessionCompact: Hook<'session.compact'> = async ($, e, next) => {
  const r = await next(e);
  if (mode === 'off') return r;
  try {
    if (r.skip === undefined && e.agentId === undefined && e.trigger !== 'precompute') {
      await closeTask($);
      await update($, taskRef, (t) => ({ ...(t ?? emptyTask()), marker: 'compact' as const, current: null, override: null }));
      await enqueue(async () => {
        const { value } = await $.state.get(ledgerRef);
        if (value) await update($, ledgerRef, (prev) => (prev ? dropMainLineage(prev) : value));
      });
    }
  } catch {
    // fine
  }
  return r;
};

export const onTurnStart: Hook<'turn.start'> = async ($, e, next) => {
  const r = await next(e);
  runningTurn = e.turnId;
  return r;
};

export const onTurnComplete: Hook<'turn.complete'> = async ($, e, next) => {
  if (runningTurn === e.turnId) runningTurn = null;
  const r = await next(e);
  // The clean-point turn is over: make the cheaper setup the session's own choice, from the event the host allows it in.
  if (e.agentId === undefined && mode !== 'off') await safe(() => persistOverride($), undefined);
  return r;
};

// `/model` and `/effort` for the autopilot's setup, once the turn that ran on it is complete. If a command does not go
// through, the override stays and keeps the rest of the task on the cheaper setup: the task never changes model midway.
async function persistOverride($: Dollar): Promise<void> {
  const { value: t } = await $.state.get(taskRef);
  const o = t?.override;
  if (!o || o.persisted) return;
  if (o.model) {
    const ok = await within($, $.command.run({ command: 'model', args: o.model }).then(() => true, () => false), 4000);
    if (!ok) return;
  }
  if (o.effort) {
    const ok = await within($, $.command.run({ command: 'effort', args: o.effort }).then(() => true, () => false), 4000);
    if (!ok && !o.model) return;
  }
  await update($, taskRef, (x) => (x?.override ? { ...x, override: { ...x.override, persisted: true } } : (x ?? emptyTask())));
}

// P1: observes only — `e` goes down as it came and the result comes back as it came — except for one case the user
// switched on (autopilot) and only at a clean point: the main requests of a task that began there go out on the
// cheaper setup it chose, so the task is on one model from its first request to its last. Only ever downward (P3).
export const onTurnStep: Hook<'turn.step'> = async function* ($, e, next) {
  let sent = e;
  try {
    if (e.agentId === undefined && (mode === 'balanced' || mode === 'eco')) {
      const { value: t } = await $.state.get(taskRef);
      const rewrite = t?.override ? overrideFor(t.override, e) : null;
      if (rewrite) sent = { ...e, ...(rewrite.model ? { model: rewrite.model } : {}), ...(rewrite.effort ? { effort: rewrite.effort } : {}) };
    }
  } catch {
    sent = e;
  }
  const r = yield* next(sent);
  const usage = r.usage;
  if (mode === 'off' || !usage) return r;
  try {
    const ts = await $.clock.now();
    if (subscription === undefined) {
      let isSub = false;
      try {
        isSub = (await $.session.authorize())?.kind === 'bearer';
      } catch {
        // no credential to hold
      }
      subscription = isSub;
    }
    const isSub = subscription;
    let sevenDayPct: number | null = null;
    let resetsAt = 'unknown';
    if (isSub) {
      try {
        const w = (await $.session.usage()).rateLimits.find((x) => x.kind === 'seven_day');
        sevenDayPct = w?.percentUsed ?? null;
        resetsAt = w?.resetsAt ?? resetsAt;
      } catch {
        // no reading
      }
    }
    const input: StepInput = {
      ts,
      lineage: lineageOf(e.agentId),
      model: usage.model || e.model,
      effort: sent.effort === undefined ? null : String(sent.effort),
      usage,
      mode,
      isSubscription: isSub,
      sevenDayPct,
    };
    await enqueue(async () => {
      let step: AgentoStep | undefined;
      const l = await update($, ledgerRef, (prev) => {
        const folded = applyStep(prev, input);
        step = folded.recent[folded.recent.length - 1];
        return folded;
      });
      if (step) {
        const key = dayKey(ts);
        const prev = await $.store.get(key);
        await $.store.set(key, foldDay(prev, step));
        if (!pruned) {
          pruned = true;
          for (const k of expiredDayKeys(await $.store.keys(), ts)) await $.store.delete(k);
        }
        // The main thread's step belongs to the task in progress: its cost feeds the per-class averages.
        if (step.lineage === 'main') {
          const cost = step.cost ?? 0;
          const model = step.model;
          await update($, taskRef, (t) => (t?.current ? { ...t, current: { ...t.current, cost: t.current.cost + cost, steps: t.current.steps + 1, tier: tierOf(model) } } : (t ?? emptyTask())));
        }
        // A subscriber's weekly-limit percent against the dollars spent in that window (spec §7.8).
        if (isSub) {
          const prevCal = await $.store.get(CALIBRATION_KEY);
          await $.store.set(CALIBRATION_KEY, recordStep(prevCal, resetsAt, step.cost ?? 0, sevenDayPct));
        }
      }
      $.ui.status(formatStatus(l, await $.clock.now()));
    });
  } catch {
    // the ledger is a convenience, never a reason to fail a step
  }
  return r;
};

export const onAgentSpawn: Hook<'agent.spawn'> = async ($, e, next) => {
  const { model, reason } = chooseSpawnModel(mode, e);
  if (!model) return next(e);
  let res;
  try {
    res = await next({ ...e, model });
  } catch {
    return next(e);
  }
  try {
    if (res.deny === undefined && res.agentId) {
      const d: AgentoSpawnDecision = {
        ts: await $.clock.now(),
        agentId: res.agentId,
        subagentType: e.subagentType,
        parentModel: e.parentModel,
        model,
        reason,
        mechanism: 'spawn-routing',
      };
      await enqueue(async () => {
        await update($, ledgerRef, (prev) => applyDecision(prev, d, mode, subscription ?? false));
        await bumpDay($, d.ts, { routedSpawns: 1 });
      });
    }
  } catch {
    // not recording is fine
  }
  return res;
};

// ---- tool.call: loop guard (S7) and the approved plan (S2) ----

export const onToolCall: Hook<'tool.call'> = async ($, e, next) => {
  const r = await next(e);
  if (mode === 'off' || r.deny !== undefined) return r;
  try {
    const lineage = lineageOf(e.agentId);
    const at = await $.clock.now();
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e as Record<string, unknown>;
    const sig = guard.push({ tool: String(tool), input, isError: r.isError === true, text: r.text, at, lineage });
    if (sig) {
      const money = await moneyOf($);
      const { value: l } = await $.state.get(ledgerRef);
      const last = l?.recent.filter((s) => s.lineage === lineage).pop();
      const cwd = await safe(() => $.session.cwd(), '');
      // S7 outranks every other banner: the agent is burning the whole prefix on every extra step.
      await showBanner($, s7Banner({ sig, lineage, stepUsd: last?.cost ?? null, money }), cwd);
      const rec: AgentoLoopSignalRecord = { ts: at, lineage, kind: sig.kind, count: sig.count, detail: sig.detail };
      await enqueue(async () => {
        await update($, ledgerRef, (prev) => applySignal(prev, rec, mode, subscription ?? false));
        await bumpDay($, at, { loopSignals: 1 });
      });
    }
    if (e.tool === 'ExitPlanMode' && lineage === 'main' && r.isError !== true) await planApproved($, r.result);
  } catch {
    // the guard is advisory
  }
  return r;
};

// ExitPlanMode went through: offer to write the code on Sonnet from a clean context (S2, spec §7.4).
async function planApproved($: Dollar, result: unknown): Promise<void> {
  if (mode === 'quality' || !suggestionsOn) return;
  const res = (result ?? {}) as { plan?: string | null; filePath?: string; awaitingLeaderApproval?: boolean };
  if (res.awaitingLeaderApproval) return;
  const cwd = await safe(() => $.session.cwd(), '');
  if ((await dismissedFor($, cwd)).includes('S2')) return;
  // The tool's own output carries the plan; the file it was saved to is the fallback.
  let plan = typeof res.plan === 'string' && res.plan.trim() ? res.plan : null;
  if (!plan && res.filePath) plan = await safe(async () => (await $.fs.read(res.filePath as string)) as string, null);
  if (plan && plan.length > MAX_PLAN_CHARS) plan = plan.slice(0, MAX_PLAN_CHARS);
  const { value: l } = await $.state.get(ledgerRef);
  const { value: s } = await $.state.get(sessionRef);
  const plannerTokens = l?.lineages.main?.prefixTokens ?? null;
  const planner = l?.main?.model ?? '';
  const saving = plannerTokens && planner ? handoffSaving(planner, 'sonnet', plannerTokens, DEFAULT_TASK_STEPS.default) : null;
  const money = await moneyOf($);
  await showBanner($, s2bBanner({ plan, plannerTokens, savingUsd: saving, orchestrate: s?.orchestrate === true, money }), cwd);
}

// ---- prompt.compose: the one stable section of orchestrator mode (P7) ----

export const onPromptCompose: Hook<'prompt.compose'> = async ($, e, next) => {
  const r = await next(e);
  try {
    // Decided at session.start and kept in session state: a later setting change reaches the next session only.
    const { value: s } = await $.state.get(sessionRef);
    if (!s?.orchestrate) return r;
    const section = orchestrateSection(s.lang);
    if (r.sections.some((x) => x.id === section.id)) return r;
    return { sections: [...r.sections, section] };
  } catch {
    return r;
  }
};

// ---- prompt.submit: task start, S1 / S4 / S2 banners, autopilot ----

export const onPromptSubmit: Hook<'prompt.submit'> = async ($, e, next) => {
  const own = e.origin.kind === 'composer' || e.origin.kind === 'bridge';
  if (mode === 'off' || !own) return next(e);
  let ctx: readonly string[] | undefined = e.context;
  try {
    // The agent hint from an S7 banner rides this prompt as context; it is never a prompt of its own.
    const { value: t } = await $.state.get(taskRef);
    if (t?.pendingHint) {
      ctx = [...(ctx ?? []), t.pendingHint];
      await update($, taskRef, (x) => ({ ...(x ?? emptyTask()), pendingHint: null }));
    }
  } catch {
    // no hint is fine
  }
  try {
    await onPrompt($, e.text);
  } catch {
    // fail-open: the prompt goes on as typed
  }
  return next(ctx === e.context ? e : { ...e, context: ctx });
};

async function onPrompt($: Dollar, text: string): Promise<void> {
  const now = await $.clock.now();
  const { value: t0 } = await $.state.get(taskRef);
  const task = t0 ?? emptyTask();
  const { value: l } = await $.state.get(ledgerRef);
  const cwd = await safe(() => $.session.cwd(), '');
  const mainCache = l?.lineages.main;
  const current = {
    model: await safe(() => $.session.model(), l?.main?.model ?? ''),
    effort: l?.main?.effort ?? (await safe(async () => {
      const s = (await $.settings.read()) as { effortLevel?: unknown };
      return typeof s.effortLevel === 'string' ? s.effortLevel : null;
    }, null)),
  };
  const facts: PromptFacts = {
    mode,
    autopilot,
    suggestions: suggestionsOn,
    prompt: text,
    prevPrompt: task.lastPrompt,
    isFirstPrompt: task.prompts === 0,
    marker: task.marker,
    explicitNew: task.explicitNew,
    mainCache,
    now,
    current,
    contextTokens: mainCache?.prefixTokens ?? 0,
    dismissed: await dismissedFor($, cwd),
    shown: task.shown,
  };
  const dec = task.quiet ? null : decidePrompt(facts);

  // A new task closes the old one's books before anything else.
  if (dec?.start) await closeTask($);
  // The old banner was about the old prompt; S7 stays until it is dealt with.
  await clearBanner($, (b) => b.scenario === 'S7');
  await update($, taskRef, (t) => {
    const base = t ?? emptyTask();
    return {
      ...base,
      prompts: base.prompts + 1,
      lastPrompt: text,
      lastPromptAt: now,
      marker: null,
      explicitNew: false,
      quiet: false,
      shown: dec?.start ? [] : base.shown,
      // A new task is a new decision; the old override belonged to the old one.
      override: dec?.start ? null : base.override,
      current: dec?.start && dec.verdict ? { class: classOf(dec.verdict), tier: null, cost: 0, steps: 0 } : base.current,
    };
  });
  if (!dec || dec.action.kind === 'none') return;

  const money = await moneyOf($);
  const verdict = dec.verdict;
  const stats = verdict ? await classStatsOf($, classOf(verdict)) : undefined;
  const action = dec.action;

  if (action.kind === 'S4') {
    const tokens = dec.start ? dec.start.contextTokens : facts.contextTokens;
    const perStep = readCostPerStep(current.model, tokens);
    const shown = await showBanner($, s4Banner({ why: action.why, contextTokens: tokens, perStepUsd: perStep, taskSavingUsd: perStep === null ? null : perStep * DEFAULT_TASK_STEPS.default, prompt: text, money }), cwd);
    if (shown) await markShown($, 'S4');
    return;
  }
  if (!verdict) return;

  if (action.kind === 'S2a') {
    // What a step costs more on Opus than on the model the user is on now.
    const extra = stepSaving('opus', current.model);
    await showBanner($, s2aBanner({ verdict, current, stepExtraUsd: extra !== null && extra > 0 ? extra : null, money }), cwd);
    await markShown($, 'S2');
    return;
  }

  const saving = action.down.model ? estimateSaving(classOf(verdict), current.model, action.down.model, stats) : null;
  const input = { down: action.down, verdict, current, saving, money };
  if (action.kind === 'autopilot') {
    const override = makeOverride(action.down, current, now);
    if (override) {
      // Decided here, applied from the task's first request (see onTurnStep); `/model` follows when the turn completes.
      await update($, taskRef, (t) => ({ ...(t ?? emptyTask()), override }));
      if (override.model) {
        await enqueue(async () => {
          await update($, ledgerRef, (prev) => applyCredit(prev, { mechanism: 'autopilot', fromModel: current.model, model: override.model as string, since: now }, now, mode, subscription ?? false));
        });
      }
      await countHint($, 'auto');
      $.ui.toast(autopilotToast(input), { timeoutMs: 8000 });
      await showBanner($, autopilotBanner(input), cwd);
      return;
    }
    // The target's id cannot be named safely: leave it to the person as an ordinary suggestion.
  }
  const shown = await showBanner($, s1Banner(input), cwd);
  if (shown) await markShown($, 'S1');
}

async function classStatsOf($: Dollar, c: TaskClass): Promise<ClassStats | undefined> {
  const v = await safe(() => $.store.get(classKey(c)), undefined);
  return isClassStats(v) ? v : undefined;
}

async function markShown($: Dollar, scenario: string): Promise<void> {
  await update($, taskRef, (t) => {
    const base = t ?? emptyTask();
    return base.shown.includes(scenario) ? base : { ...base, shown: [...base.shown, scenario] };
  });
}

// ---- banner buttons ----

async function toBanner($: Dollar, banner: AgentoBanner, patch: Partial<AgentoBanner>): Promise<void> {
  await update($, bannerRef, (cur) => (cur && cur.id === banner.id ? { ...cur, ...patch } : (cur ?? null)));
}

async function dismiss($: Dollar, banner: AgentoBanner): Promise<void> {
  const k = dismissKeyOf(banner.scenario);
  if (k) await $.store.set(dismissStoreKey(k, banner.cwd), true);
  await countHint($, 'dismissed');
}

async function setCredit($: Dollar, mechanism: 'suggestion-accepted' | 'handoff', fromModel: string, model: string): Promise<void> {
  const now = await $.clock.now();
  await enqueue(async () => {
    await update($, ledgerRef, (prev) => applyCredit(prev, { mechanism, fromModel, model, since: now }, now, mode, subscription ?? false));
  });
}

// The compaction brief for S4: keep what the next task may still need.
const COMPACT_RU = 'Сохрани: цель текущей работы, принятые решения и их причины, пути изменённых файлов, нерешённые вопросы и последние ошибки. Остальное сожми.';
const COMPACT_EN = 'Keep: the goal of the current work, decisions made and why, paths of changed files, open questions and the latest errors. Compress the rest.';

async function onBannerAction($: Dollar, banner: AgentoBanner, key: string): Promise<void> {
  try {
    const lang = await langOf($);
    const d = banner.data;
    switch (banner.scenario) {
      case 'S1': {
        if (key === 'keep') return await clearBanner($);
        if (key === 'never') {
          await dismiss($, banner);
          return await clearBanner($);
        }
        if (key === 'model' && d.model) {
          await $.command.run({ command: 'model', args: d.model });
          if (d.fromModel) await setCredit($, 'suggestion-accepted', d.fromModel, d.model);
          await countHint($, 'accepted');
          if (d.effort) {
            await toBanner($, banner, { actions: banner.actions.filter((a) => a.key !== 'model'), data: { ...d, model: undefined } });
            return;
          }
        } else if (key === 'effort' && d.effort) {
          await $.command.run({ command: 'effort', args: d.effort });
          await countHint($, 'accepted');
          if (d.model) {
            await toBanner($, banner, { actions: banner.actions.filter((a) => a.key !== 'effort'), data: { ...d, effort: undefined } });
            return;
          }
        }
        return await clearBanner($);
      }
      case 'AP': {
        if (key === 'undo') {
          // Not yet persisted: dropping the override sends the task's next request on the user's own setup. Persisted:
          // the session itself was moved, so it is moved back.
          const { value: t } = await $.state.get(taskRef);
          await update($, taskRef, (x) => ({ ...(x ?? emptyTask()), override: null }));
          if (t?.override?.persisted) {
            if (d.model && d.fromModel) await $.command.run({ command: 'model', args: d.fromModel });
            if (d.effort && d.fromEffort) await $.command.run({ command: 'effort', args: d.fromEffort });
          }
          const now = await $.clock.now();
          await enqueue(async () => {
            await update($, ledgerRef, (prev) => applyCredit(prev, null, now, mode, subscription ?? false));
          });
        } else if (key === 'disable') {
          autopilot = 'off';
          await $.config.set({ key: 'agento.autopilot', value: 'off' });
        }
        return await clearBanner($);
      }
      case 'S2a': {
        if (key === 'never') {
          await dismiss($, banner);
        } else if (key === 'discuss') {
          await $.command.run({ command: 'model', args: 'opus' });
          // `/plan` enters plan mode where the build has it; otherwise the person is pointed at the key.
          const hasPlan = (await safe(() => $.command.list(), [])).some((c) => c.name === 'plan');
          if (hasPlan) await $.command.run({ command: 'plan' });
          else $.ui.toast(lang === 'ru' ? 'Opus выбран. Включите plan mode: Shift+Tab' : 'Opus selected. Turn on plan mode: Shift+Tab', { timeoutMs: 6000 });
          await countHint($, 'accepted');
        }
        return await clearBanner($);
      }
      case 'S2b': {
        if (key === 'never') {
          await dismiss($, banner);
        } else if (key === 'handoff') {
          if (!(await handoff($, banner, lang))) return;
        } else if (key === 'orchestra') {
          await $.prompt.fill({ text: lang === 'ru' ? 'Реализуй одобренный план: самодостаточные куски отдавай agento-builder, прогон тестов — agento-checker, поиск по коду — agento-scout.' : 'Implement the approved plan: hand self-contained pieces to agento-builder, test runs to agento-checker, code search to agento-scout.' });
          await countHint($, 'accepted');
        }
        return await clearBanner($);
      }
      case 'S4': {
        if (key === 'never') {
          await dismiss($, banner);
        } else if (key === 'clear') {
          await $.command.run({ command: 'clear' });
          if (d.prompt) await $.prompt.fill({ text: d.prompt });
          await countHint($, 'accepted');
          $.ui.toast(lang === 'ru' ? 'Контекст очищен. Промпт в поле ввода: Enter, чтобы отправить' : 'Context cleared. Your prompt is in the input box: press Enter to send it', { timeoutMs: 6000 });
        } else if (key === 'compact') {
          if (d.prompt) await $.prompt.fill({ text: d.prompt });
          await countHint($, 'accepted');
          await $.command.run({ command: 'compact', args: lang === 'ru' ? COMPACT_RU : COMPACT_EN });
        }
        return await clearBanner($);
      }
      case 'S7': {
        if (key === 'stop') {
          if (runningTurn) await $.turn.abort({ turnId: runningTurn });
          else $.ui.toast(lang === 'ru' ? 'Сейчас ничего не выполняется' : 'Nothing is running right now');
        } else if (key === 'hint') {
          // Added to the context of the person's next prompt; nothing is submitted for them.
          await update($, taskRef, (t) => ({ ...(t ?? emptyTask()), pendingHint: agentHint(lang, d.detail ?? '') }));
          $.ui.toast(lang === 'ru' ? 'Подсказка уйдёт агенту вместе с вашим следующим сообщением' : 'The hint goes to the agent with your next message', { timeoutMs: 6000 });
        }
        return await clearBanner($);
      }
    }
  } catch {
    // a button that fails leaves the banner where it is, and the session untouched
  }
}

// Plan to a file, a clean context, Sonnet, and the instruction in the prompt box — for the person to send.
async function handoff($: Dollar, banner: AgentoBanner, lang: Lang): Promise<boolean> {
  const plan = banner.data.plan;
  if (!plan) {
    $.ui.toast(lang === 'ru' ? 'План не найден: сохранить нечего' : 'No plan text found: nothing to save', { timeoutMs: 6000 });
    return false;
  }
  const now = await $.clock.now();
  const date = dayKey(now).slice('day:'.length);
  let path = planPath(date, plan);
  for (let attempt = 1; attempt < 20 && (await safe(() => $.fs.exists(path), false)); attempt += 1) path = planPath(date, plan, attempt);
  await $.fs.write(path, planDocument(plan));
  const { value: l } = await $.state.get(ledgerRef);
  const plannerTokens = l?.lineages.main?.prefixTokens ?? null;
  const fromModel = l?.main?.model ?? '';
  // The plan is a new task's start: the model carrying on is the plan's reader, so the planning turn must end first.
  if (runningTurn) await safe(() => $.turn.abort({ turnId: runningTurn as string }), undefined);
  await $.command.run({ command: 'clear' });
  // The plan is saved and the context is gone: if the switch fails, the person is told to make it themselves.
  const switched = await safe(() => $.command.run({ command: 'model', args: 'sonnet' }).then(() => true), false);
  if (!switched) $.ui.toast(lang === 'ru' ? 'Не удалось выбрать Sonnet: выполните /model sonnet' : 'Could not select Sonnet: run /model sonnet', { timeoutMs: 8000 });
  // The next prompt is agento's own: it must not be met with suggestions.
  await update($, taskRef, (t) => ({ ...(t ?? emptyTask()), quiet: true }));
  await $.prompt.fill({ text: handoffPrompt(path, lang) });
  await enqueue(async () => {
    await update($, ledgerRef, (prev) => applyHandoff(prev, { ts: now, planPath: path, plannerTokens, executorTokens: null }, mode, subscription ?? false));
  });
  if (fromModel) await setCredit($, 'handoff', fromModel, TIER_ALIAS.sonnet);
  await countHint($, 'accepted');
  $.ui.toast(lang === 'ru' ? `План сохранён: ${path}. Enter — начать на Sonnet` : `Plan saved: ${path}. Press Enter to start on Sonnet`, { timeoutMs: 8000 });
  return true;
}

// ---- /agento ----

export const onCommandRun: Hook<'command.run'> = async ($, e, next) => {
  if (e.command !== 'agento') return next(e);
  try {
    const lang = await langOf($);
    const ru = lang === 'ru';
    const cmd = parseAgentoArgs(e.args);
    switch (cmd.kind) {
      case 'open': {
        const opened = await $.ui.open({ id: PANE_ID, title: 'agento' });
        return opened.isPlaced ? {} : { text: ru ? 'Панель не поместилась: расширьте терминал и повторите /agento' : 'The panel does not fit: widen the terminal and run /agento again' };
      }
      case 'new': {
        await update($, taskRef, (t) => ({ ...(t ?? emptyTask()), explicitNew: true }));
        // A long, warm conversation is not a clean point: the clean start is /clear (S4).
        const { value: l } = await $.state.get(ledgerRef);
        const main = l?.lineages.main;
        const now = await $.clock.now();
        if (suggestionsOn && mode !== 'off' && main && isWarm(main, now) && main.prefixTokens > S4_CONTEXT_TOKENS) {
          const cwd = await safe(() => $.session.cwd(), '');
          if (!(await dismissedFor($, cwd)).includes('S4')) {
            const perStep = readCostPerStep(main.model, main.prefixTokens);
            await showBanner($, s4Banner({ why: 'new-task', contextTokens: main.prefixTokens, perStepUsd: perStep, taskSavingUsd: perStep === null ? null : perStep * DEFAULT_TASK_STEPS.default, prompt: '', money: await moneyOf($) }), cwd);
          }
        }
        return { text: ru ? 'Следующий промпт считается новой задачей.' : 'The next prompt counts as a new task.' };
      }
      case 'mode': {
        const res = await $.config.set({ key: 'agento.mode', value: cmd.value });
        if (res.deny !== undefined) return { text: `agento: ${res.deny}` };
        mode = cmd.value;
        return { text: `mode: ${cmd.value}` };
      }
      case 'autopilot': {
        const res = await $.config.set({ key: 'agento.autopilot', value: cmd.value });
        if (res.deny !== undefined) return { text: `agento: ${res.deny}` };
        autopilot = cmd.value;
        return { text: `autopilot: ${cmd.value}` };
      }
      case 'orchestrate': {
        const res = await $.config.set({ key: 'agento.orchestrate', value: cmd.value });
        if (res.deny !== undefined) return { text: `agento: ${res.deny}` };
        orchestrateOn = cmd.value === 'on';
        // P7: the system prompt was fixed when this session started.
        return { text: ru ? `orchestrate: ${cmd.value} — применится со следующей сессии (system prompt фиксируется при старте)` : `orchestrate: ${cmd.value} — applies from the next session (the system prompt is fixed at start)` };
      }
      case 'invalid':
        return { text: cmd.usage };
    }
  } catch {
    return next(e);
  }
};

// A `/model` the person types ends autopilot's hold on the task: their choice is theirs.
export const onModelCommand: Hook<'command.run'> = async ($, e, next) => {
  try {
    if (mode !== 'off' && e.origin.kind !== 'plugin') await update($, taskRef, (t) => (t?.override ? { ...t, override: null } : (t ?? emptyTask())));
  } catch {
    // fine
  }
  return next(e);
};

// ---- ui.render: the banner above the prompt ----

const TONE_OF_SCENARIO = { S1: 'suggestion', S2a: 'suggestion', S2b: 'suggestion', S4: 'suggestion', S7: 'warning', AP: 'success' } as const;

export const onRenderBand: MatchedHook<'ui.render', { component: 'AbovePrompt' }> = async ($, e, next) => {
  try {
    const { value: banner } = await $.state.get(bannerRef);
    // A survey holds the band; so does nothing at all to say.
    if (!banner || e.props.hasSurvey) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="claude">◆ </Text>
          <Text bold color={TONE_OF_SCENARIO[banner.scenario]}>
            {banner.title}
          </Text>
        </Box>
        <Text dimColor>{banner.reason}</Text>
        {banner.estimate ? <Text dimColor>{banner.estimate}</Text> : null}
        <Box gap={1}>
          {banner.actions.map((a) => (
            <Button key={a.key} label={a.label} variant={a.primary ? 'primary' : 'secondary'} onPress={() => onBannerAction($, banner, a.key)} />
          ))}
        </Box>
      </Box>
    );
  } catch {
    return next(e);
  }
};

// ---- ui.render: the /agento pane ----

const COLOR: Record<Tone, string | undefined> = { plain: undefined, dim: undefined, accent: 'claude', success: 'success', warning: 'warning' };

async function panelData($: Dollar, range: AgentoPaneRange): Promise<PanelData> {
  const now = await $.clock.now();
  const { value: stored } = await $.state.get(ledgerRef);
  const l: AgentoLedger = stored ?? emptyLedger(now, mode, subscription ?? false);
  const { value: s } = await $.state.get(sessionRef);
  const cal = await safe(() => $.store.get(CALIBRATION_KEY), undefined);
  let numbers = sessionNumbers(l);
  if (range !== 'session') {
    const keys = await safe(() => $.store.keys(), [] as string[]);
    const want = rangeDays(range, now, dayKey).keys;
    const days: DayAggregate[] = [];
    for (const k of keys) {
      if (!k.startsWith('day:') || (want !== 'all' && !want.includes(k))) continue;
      const v = await safe(() => $.store.get(k), undefined);
      if (isDay(v)) days.push(normalizeDay(v));
    }
    numbers = foldDays(days);
  }
  const last = l.signals[l.signals.length - 1];
  return {
    range,
    now,
    mode: l.mode ?? mode,
    autopilot,
    orchestrate: orchestrateOn,
    orchestrateFixed: s?.orchestrate === true,
    isSubscription: l.isSubscription,
    sevenDayPct: l.sevenDayPct,
    pctPerUsd: isCalibration(cal) ? fitPctPerUsd(cal) : null,
    startedAt: s?.startedAt ?? l.startedAt,
    ...numbers,
    lastSignal: last ? `${last.detail}` : null,
    cache: l.lineages.main,
    handoff: l.handoff ?? null,
  };
}

export const onRenderPane: MatchedHook<'ui.render', { component: 'Pane'; requestId: 'agento' }> = async ($, e, next) => {
  try {
    const lang = await langOf($);
    const { value: range = 'session' } = await $.state.get(rangeRef);
    const model = buildPanel(await panelData($, range), lang);
    const { Box, Text, Button } = $.ui.resolve(e);
    const width = Math.max(20, Math.min(e.props.bodyColumns, 76));
    const label = (r: Row) => r.label.padEnd(11);
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box key="title">
            {model.title.map((t) => (
              <Text bold={t.tone !== 'accent'} color={COLOR[t.tone ?? 'plain']}>
                {t.text}
              </Text>
            ))}
          </Box>
          <Text dimColor>{model.modeText}</Text>
        </Box>
        <Text dimColor>{'─'.repeat(width)}</Text>
        {model.rows.map((r) => (
          <Box key={`row:${r.label}`}>
            <Text dimColor>{label(r)}</Text>
            <Box key={`val:${r.label}`}>
              {r.segs.map((seg) => (
                <Text color={COLOR[seg.tone ?? 'plain']} dimColor={seg.tone === 'dim'} wrap="truncate-end">
                  {seg.text}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
        <Text dimColor>{'─'.repeat(width)}</Text>
        <Box gap={1}>
          <Button key="mode" label={`${model.buttons.mode}: ${model.modeText.slice('mode: '.length)}`} onPress={() => cycleMode($)} />
          <Button key="orchestrate" label={model.buttons.orchestrate} onPress={() => toggleOrchestrate($)} />
          <Button key="autopilot" label={model.buttons.autopilot} onPress={() => toggleAutopilot($)} />
        </Box>
        <Box gap={1}>
          {model.rangeOptions.map((o) => (
            <Button key={`range:${o.value}`} label={o.label} variant={o.value === range ? 'primary' : 'secondary'} onPress={() => setRange($, o.value)} />
          ))}
        </Box>
        {model.note ? <Text dimColor>{model.note}</Text> : null}
      </Box>
    );
  } catch {
    return next(e);
  }
};

async function setRange($: Dollar, range: AgentoPaneRange): Promise<void> {
  try {
    await update($, rangeRef, () => range);
  } catch {
    // fine
  }
}

async function cycleMode($: Dollar): Promise<void> {
  try {
    const value = nextMode(mode);
    const res = await $.config.set({ key: 'agento.mode', value });
    if (res.deny === undefined) mode = value;
    $.ui.invalidate('ui.render');
  } catch {
    // fine
  }
}

async function toggleOrchestrate($: Dollar): Promise<void> {
  try {
    const value = orchestrateOn ? 'off' : 'on';
    const res = await $.config.set({ key: 'agento.orchestrate', value });
    if (res.deny === undefined) orchestrateOn = value === 'on';
    $.ui.invalidate('ui.render');
  } catch {
    // fine
  }
}

async function toggleAutopilot($: Dollar): Promise<void> {
  try {
    const value: Autopilot = autopilot === 'off' ? 'clean-points' : 'off';
    const res = await $.config.set({ key: 'agento.autopilot', value });
    if (res.deny === undefined) autopilot = value;
    $.ui.invalidate('ui.render');
  } catch {
    // fine
  }
}
