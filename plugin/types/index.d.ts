// The contract of agento's session state ($.state). Self-contained: no imports.

export type AgentoMode = 'balanced' | 'eco' | 'quality' | 'off';

// `main` or `agent:<agentId>`.
export type AgentoLineage = string;

export type AgentoTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// Only agento's own mechanisms are ever credited with savings (P6).
export type AgentoMechanism = 'spawn-routing' | 'suggestion-accepted' | 'handoff' | 'autopilot';

export type AgentoStep = {
  ts: number;
  lineage: AgentoLineage;
  model: string;
  effort: string | null;
  tokens: AgentoTokens;
  // API-equivalent dollars at list price; null for a model with no known price.
  cost: number | null;
  // The same tokens at the baseline model's price.
  baselineCost: number | null;
  mechanism: AgentoMechanism | null;
  // For a mechanism: the estimated dollars it saved on this step (an estimate, upper bound).
  savedEstimate: number | null;
};

export type AgentoLineageCache = {
  model: string;
  prefixTokens: number;
  lastAt: number;
  ttl: '5m' | '1h';
};

export type AgentoSpawnDecision = {
  ts: number;
  agentId: string;
  subagentType: string;
  parentModel: string;
  model: string;
  reason: string;
  mechanism: 'spawn-routing';
};

export type AgentoLoopSignalRecord = {
  ts: number;
  lineage: AgentoLineage;
  kind: 'failing-test' | 'same-edit' | 'error-streak';
  count: number;
  detail: string;
};

export type AgentoHintCounts = { shown: number; accepted: number; dismissed: number; auto: number };

export type AgentoCredit = {
  mechanism: 'suggestion-accepted' | 'autopilot' | 'handoff';
  // The model the user was on before agento's change (what the savings are measured against).
  fromModel: string;
  // The tier alias agento moved to (`sonnet`): the credit ends when the user is on another tier.
  model: string;
  since: number;
};

export type AgentoHandoffRecord = {
  ts: number;
  planPath: string;
  // Tokens the planning conversation carried (main prefix at the handoff) and the executor's first prefix.
  plannerTokens: number | null;
  executorTokens: number | null;
};

export type AgentoModelTotals = { steps: number; cost: number };

// One task-start classification and what it led to: who decided (`rules-v1` or `brain:<run_id>`), and why a trained
// classifier's answer was not used when it was asked and the rules answered.
export type AgentoRoute = {
  ts: number;
  classifier: string;
  fallback?: string;
  tier: string;
  effort: string;
  confidence: number;
  // Asked of the trained classifier only; `delegateExplore` is recorded and nothing acts on it yet.
  planFirst?: boolean;
  delegateExplore?: boolean;
  latencyMs?: number;
  // `autopilot`, `S1`, `S2a`, `S3` (trajectory), `S4` or `none`.
  action: string;
  // Absent for a task-start classification; `trajectory` for the decision after the task's first steps, which also
  // carries its complexity (`small`, `medium`, `large`) and the reasons. Its `tier` is the ceiling it set for subagents
  // (else the tier the task runs on), and its confidence is 0: it is a heuristic, not a classifier's score.
  stage?: 'trajectory';
  complexity?: string;
  reasons?: string[];
};

export type AgentoLedger = {
  startedAt: number;
  // The model the user started on: what savings are measured against. Empty until the first main step.
  baselineModel: string;
  isSubscription: boolean;
  // Percent of the 7-day limit used, as of the last step (subscriptions only; null when unknown).
  sevenDayPct: number | null;
  mode: AgentoMode;
  steps: number;
  cost: number;
  baselineCost: number;
  tokens: AgentoTokens;
  byModel: Record<string, AgentoModelTotals>;
  savedEstimate: { spawnRouting: number; suggestions: number; handoff: number; autopilot: number };
  // Banners shown / accepted / dismissed with "don't suggest again", and autopilot actions taken.
  hints: AgentoHintCounts;
  // What agento changed at the last clean point, so main steps on it can be credited (an estimate).
  credit: AgentoCredit | null;
  // The last plan-to-code handoff: context the planner carried against the executor's fresh one.
  handoff: AgentoHandoffRecord | null;
  // Main thread's model and effort as of its last step, for the status line.
  main: { model: string; effort: string | null } | null;
  lineages: Record<AgentoLineage, AgentoLineageCache>;
  // Subagents that agento routed: agentId -> decision. Kept so their steps can be credited.
  routed: Record<string, AgentoSpawnDecision>;
  decisions: AgentoSpawnDecision[];
  // Classifications at task starts, newest last (capped). Absent in a ledger an older version wrote.
  routes?: AgentoRoute[];
  signals: AgentoLoopSignalRecord[];
  // The most recent steps, newest last (capped).
  recent: AgentoStep[];
};

// ---- suggestions (one banner above the prompt at a time) ----

export type AgentoScenario = 'S1' | 'S2a' | 'S2b' | 'S3' | 'S4' | 'S7' | 'AP';

export type AgentoBannerAction = {
  // `model`, `effort`, `keep`, `never`, `undo`, `disable`, `ok`, `discuss`, `handoff`, `continue`, `orchestra`, `clear`, `compact`, `stop`, `hint`.
  key: string;
  label: string;
  primary?: boolean;
};

export type AgentoBannerData = {
  // A tier alias agento would move to (`sonnet`) and an effort level.
  model?: string;
  effort?: string;
  fromModel?: string;
  fromEffort?: string | null;
  estimateUsd?: number | null;
  // S2b: the plan text; S4: the prompt that came in, to put back after /clear.
  plan?: string;
  prompt?: string;
  // S7: the lineage that is stuck and a one-line description.
  lineage?: string;
  detail?: string;
};

export type AgentoBanner = {
  id: string;
  scenario: AgentoScenario;
  ts: number;
  cwd: string;
  title: string;
  // One line: why.
  reason: string;
  // One line: what it is worth, marked as an estimate. Null for a notice without one.
  estimate: string | null;
  actions: AgentoBannerAction[];
  data: AgentoBannerData;
};

export type AgentoOverride = {
  model?: string;
  modelId?: string;
  effort?: string;
  fromModel: string;
  fromEffort: string | null;
  persisted: boolean;
  since: number;
};

// What the main thread's first steps of the task showed (core/trajectory.ts), and what was decided from it.
export type AgentoTrajectory = {
  steps: number;
  reads: number;
  searches: number;
  filesRead: string[];
  edits: number;
  filesEdited: string[];
  editChars: number;
  toolErrors: number;
  errorStreak: number;
  failingTests: number;
  inputTokens: number;
  outputTokens: number;
  hasEdit: boolean;
};

export type AgentoTrajectoryVerdict = {
  complexity: 'small' | 'medium' | 'large';
  // The ceiling for the model of subagents spawned later in the task.
  spawnTier: 'haiku' | 'sonnet' | 'opus' | 'fable' | null;
  handoff: boolean;
  handoffSavingUsd: number | null;
  mainDowngrade: { to: 'sonnet'; breakEvenSteps: number; penaltyUsd: number; perStepUsd: number; savingUsd: number } | null;
  reasons: string[];
};

// What the prompt hook knows about the current task and what lets the next one be told apart.
export type AgentoTask = {
  prompts: number;
  lastPrompt: string;
  lastPromptAt: number;
  // The task's last few prompts (this one included, each cut short), for telling a return to an earlier subtopic from a
  // new topic. Absent in state an older version wrote; reset where the task starts.
  recentPrompts?: string[];
  // A /clear or a compaction since the last prompt.
  marker: 'clear' | 'compact' | null;
  // `/agento new`: the next prompt starts a task.
  explicitNew: boolean;
  // Scenarios already shown for the task in progress (S1/S4 at most once per task).
  shown: string[];
  // The running task's cost, folded into the per-class averages when the next task starts.
  current: { class: string; tier: string | null; cost: number; steps: number } | null;
  // Autopilot at the clean point that began this task: its main requests go out on the cheaper setup (see core/suggest.ts).
  override: AgentoOverride | null;
  // A hint for the agent that rides the next prompt's context.
  pendingHint: string | null;
  // The next prompt is agento's own (the handoff's "implement the plan"): suggest nothing on it.
  quiet: boolean;
  // Absent in state an older version wrote: read as nothing seen yet, nothing decided.
  trajectory?: AgentoTrajectory;
  // Set once per task, when the checkpoint was reached (it stays for the spawns that follow).
  trajectoryVerdict?: AgentoTrajectoryVerdict | null;
  // The verdict of the prompt that began the task, for the trajectory to confirm or lower.
  promptVerdict?: { tier: string; effort: string; confidence: number; planFirst?: boolean } | null;
};

// Fixed at session.start: what the system prompt carries is identical for the whole session (P7).
export type AgentoSession = {
  lang: 'ru' | 'en';
  orchestrate: boolean;
  startedAt: number;
};

// What the plugin knows of the local classifier daemon (`agento-brain`), from the probe at session start and the calls since.
export type AgentoBrain = {
  // `up`: the daemon answered; `down`: it did not (not asked again until `checkedAt` + 5 min); `off`: the `brain` setting.
  status: 'up' | 'down' | 'off';
  runId: string | null;
  backend: string | null;
  p50Ms: number | null;
  checkedAt: number;
  socket: string | null;
};

export type AgentoPaneRange = 'session' | 'today' | '7d' | 'all';

declare module 'claude-code' {
  interface PluginState {
    agento: {
      ledger: AgentoLedger;
      banner: AgentoBanner | null;
      task: AgentoTask;
      session: AgentoSession;
      brain: AgentoBrain;
      range: AgentoPaneRange;
    };
  }
}
