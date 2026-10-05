// Shared data model of the audit. Parser (transcripts.ts) produces a Corpus; analyzers (audit/*.ts)
// read a Corpus and each return one section of AuditReport; renderers (report/*.ts) only read AuditReport.

import type { CostBreakdown, Usage } from '../../plugin/core/cost.ts';
import type { Lineage, Ttl } from '../../plugin/core/cache.ts';
import type { ModelFamily, Tier } from '../../plugin/core/pricing.ts';

export type { CostBreakdown, Usage, Lineage, Ttl, ModelFamily, Tier };

// ───────────────────────── Corpus (parser output) ─────────────────────────

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

// One API request (deduplicated by message.id + requestId).
export interface ApiCall {
  messageId: string;
  requestId?: string;
  sessionId: string;
  project: string;
  lineage: Lineage;
  ts: number; // epoch ms
  model: string;
  usage: Usage;
  effort?: string;
  speed?: string | null;
  isSidechain: boolean;
  toolUses: ToolUse[];
  stopReason?: string;
}

// A prompt typed by the human (not tool results, not meta/system-injected rows).
export interface UserPrompt {
  uuid: string;
  sessionId: string;
  project: string;
  ts: number;
  text: string;
  isSlashCommand: boolean; // e.g. "/model sonnet"
}

export interface ToolResult {
  sessionId: string;
  lineage: Lineage;
  ts: number;
  toolUseId: string;
  isError: boolean;
  text: string; // truncated to 2000 chars
}

export type MarkerKind = 'compact' | 'clear' | 'model' | 'effort' | 'away' | 'other';

export interface SessionMarker {
  sessionId: string;
  ts: number;
  kind: MarkerKind;
  detail?: string;
}

// What `agent-<id>.meta.json` next to a subagent transcript says about it.
export interface SubagentMeta {
  type: string; // agentType: "general-purpose", "Explore", "fork", "workflow-subagent", ...
  description?: string;
}

// A `file-history-snapshot` / `file-history-delta` row: files Claude had modified in the session, each with the time of its latest backup.
export interface FileHistoryEntry {
  ts: number;
  kind: 'snapshot' | 'delta';
  files: Array<{ path: string; ts: number }>; // path as recorded: relative to cwd or absolute
}

export interface SessionData {
  sessionId: string;
  project: string; // directory name under projects/
  cwd?: string;
  gitBranch?: string;
  firstTs: number;
  lastTs: number;
  calls: ApiCall[]; // all lineages, sorted by ts
  prompts: UserPrompt[]; // sorted by ts
  toolResults: ToolResult[];
  markers: SessionMarker[];
  agents: Record<string, SubagentMeta>; // agentId -> `agent-<id>.meta.json`; empty when there are none
  fileHistory?: FileHistoryEntry[]; // sorted by ts; absent when the transcript has no such rows
  reportedCostUSD?: number; // from the last `cost-state` row, if any
}

export interface CorpusStats {
  files: number;
  lines: number;
  badLines: number;
  duplicateRows: number;
  unknownModelCalls: number;
  parseMs: number;
}

export interface Corpus {
  dir: string;
  sessions: SessionData[];
  stats: CorpusStats;
}

// ───────────────────────── AuditReport (analyzer output) ─────────────────────────

export type Confidence = 'fact' | 'estimate';

export interface Money {
  usd: number;
  kind: Confidence;
}

export interface SpendSection {
  total: CostBreakdown;
  main: CostBreakdown;
  subagents: CostBreakdown;
  byFamily: Array<{ family: ModelFamily; calls: number; cost: CostBreakdown }>;
  byProject: Array<{ project: string; cost: number; sessions: number }>;
  byDay: Array<{ date: string; cost: number }>; // YYYY-MM-DD, local time, ascending, gaps filled with 0
  byWeek: Array<{ weekStart: string; cost: number }>;
  fastModeCost: number;
  effortMix: Array<{ effort: string; calls: number; cost: number }>;
  // Sessions whose reported cost is below $0.05 are not compared. Deviations are fractions, 0.17 = 17%.
  reconciliation: { sessionsChecked: number; withinTolerance: number; medianDeviation: number; worstDeviation: number };
}

export type MissCause = 'ttl' | 'model-switch' | 'compaction' | 'effort-change' | 'unknown';

export interface CacheSection {
  hitRatio: number; // cache_read / (cache_read + cache_creation + input), main lineage
  rewriteCost: number; // total spent on avoidable-looking rewrites
  losses: Array<{ cause: MissCause; events: number; cost: number }>;
}

export interface TtlSection {
  observed: Ttl | 'mixed' | 'unknown';
  gapHistogram: Array<{ label: string; count: number }>; // e.g. "<1m", "1–5m", "5–15m", "15–60m", ">60m"
  recommendation: { ttl: Ttl; monthlySaving: Money; reason: string } | null;
}

export interface TaskSummary {
  sessionId: string;
  startTs: number;
  endTs: number;
  model: string; // dominant main model
  effort?: string;
  mainCalls: number;
  filesEdited: number;
  outputTokens: number;
  errors: number;
  cost: number;
  isLight: boolean;
  firstPrompt: string; // truncated to 200 chars
}

export interface TasksSection {
  count: number;
  light: number;
  lightOnExpensive: { count: number; cost: number; asSonnet: number }; // expensive = opus/fable
  maxEffortOnLight: number; // light tasks run with effort max or xhigh
  topExamples: TaskSummary[]; // most expensive light tasks, up to 5
}

export interface SubagentSection {
  share: number; // of total spend
  calls: number;
  cost: number;
  byFamily: Array<{ family: ModelFamily; cost: number }>;
  byType: Array<{ type: string; calls: number; cost: number }>; // by agentType from the meta files, most expensive first
  // Explore (or read-only) subagent lineages that ran above haiku.
  haikuCandidates: { count: number; cost: number; asHaiku: number };
  // general-purpose lineages (not already haiku candidates) that ran on opus/fable: the "orchestrator builder on Sonnet" case.
  sonnetCandidates: { count: number; cost: number; asSonnet: number };
}

export interface DeadContextSection {
  events: number;
  cost: number; // spent re-reading old context after a probable topic change
}

export interface SetupSection {
  avgFixedPrefixTokens: number; // cache_creation of the first call of a session
  fixedPrefixCost: number;
  claudeMd: Array<{
    path: string;
    bytes: number;
    tokens: number; // about bytes / 3.6
    monthlyReadCost: number; // cache reads of this file by sessions started in its directory, per 30 days
    trimSaving: number; // the same for the part above 20 KB, per 30 days
  }>;
}

export interface SwitchSimSection {
  rows: Array<{ from: string; to: string; prefixTokens: number; penalty: number; savingPerStep: number; breakEvenSteps: number | null }>;
}

export interface Action {
  id: string;
  title: string;
  detail: string;
  monthly: Money;
}

export interface AuditReport {
  meta: {
    generatedAt: string;
    dir: string;
    since?: string;
    sessions: number;
    files: number;
    calls: number;
    duplicateRowsDropped: number;
    badLines: number;
    unknownModelCalls: number;
    days: number;
    pricesAsOf: string;
    plan: 'subscription' | 'api' | 'unknown';
    lang: 'ru' | 'en';
  };
  spend: SpendSection;
  cache: CacheSection;
  ttl: TtlSection;
  tasks: TasksSection;
  subagents: SubagentSection;
  deadContext: DeadContextSection;
  setup: SetupSection;
  switchSim: SwitchSimSection;
  actions: Action[]; // sorted by monthly.usd desc, top 3–5
}
