// Test helper: build Corpus objects by hand, so analyzers can be tested without the parser.
import { normalizeUsage, type Usage } from '../../plugin/core/cost.ts';
import type { ApiCall, Corpus, SessionData, SessionMarker, ToolResult, UserPrompt } from '../src/types.ts';

export const T0 = Date.UTC(2026, 8, 1, 9, 0, 0); // 2026-09-01 09:00 UTC
export const MIN = 60_000;

let seq = 0;

export function call(p: Partial<Omit<ApiCall, 'usage'>> & { usage?: Partial<Usage> } = {}): ApiCall {
  seq += 1;
  return {
    messageId: p.messageId ?? `msg_${seq}`,
    requestId: p.requestId ?? `req_${seq}`,
    sessionId: p.sessionId ?? 's1',
    project: p.project ?? 'proj',
    lineage: p.lineage ?? 'main',
    ts: p.ts ?? T0 + seq * 1000,
    model: p.model ?? 'claude-opus-5-5',
    usage: normalizeUsage(p.usage),
    effort: p.effort,
    speed: p.speed ?? null,
    isSidechain: p.isSidechain ?? (p.lineage ?? 'main') !== 'main',
    toolUses: p.toolUses ?? [],
    stopReason: p.stopReason,
  };
}

export function prompt(text: string, ts: number, p: Partial<UserPrompt> = {}): UserPrompt {
  seq += 1;
  return {
    uuid: p.uuid ?? `u_${seq}`,
    sessionId: p.sessionId ?? 's1',
    project: p.project ?? 'proj',
    ts,
    text,
    isSlashCommand: p.isSlashCommand ?? text.startsWith('/'),
  };
}

export function marker(kind: SessionMarker['kind'], ts: number, sessionId = 's1', detail?: string): SessionMarker {
  return { sessionId, ts, kind, detail };
}

export function toolResult(toolUseId: string, ts: number, isError = false, text = '', p: Partial<ToolResult> = {}): ToolResult {
  return { sessionId: p.sessionId ?? 's1', lineage: p.lineage ?? 'main', ts, toolUseId, isError, text };
}

export function session(p: Partial<SessionData> & { calls?: ApiCall[] } = {}): SessionData {
  const calls = [...(p.calls ?? [])].sort((a, b) => a.ts - b.ts);
  const prompts = [...(p.prompts ?? [])].sort((a, b) => a.ts - b.ts);
  const times = [...calls.map((c) => c.ts), ...prompts.map((x) => x.ts)];
  return {
    sessionId: p.sessionId ?? calls[0]?.sessionId ?? 's1',
    project: p.project ?? calls[0]?.project ?? 'proj',
    cwd: p.cwd,
    gitBranch: p.gitBranch,
    firstTs: p.firstTs ?? (times.length ? Math.min(...times) : T0),
    lastTs: p.lastTs ?? (times.length ? Math.max(...times) : T0),
    calls,
    prompts,
    toolResults: p.toolResults ?? [],
    markers: p.markers ?? [],
    agents: p.agents ?? {},
    reportedCostUSD: p.reportedCostUSD,
  };
}

export function corpus(sessions: SessionData[]): Corpus {
  return {
    dir: '/tmp/projects',
    sessions,
    stats: { files: sessions.length, lines: 0, badLines: 0, duplicateRows: 0, unknownModelCalls: 0, parseMs: 0 },
  };
}

// A main-thread step that reads `prefix` tokens from cache and writes `fresh` new ones.
export function step(ts: number, prefix: number, fresh = 2_000, output = 1_000, p: Partial<ApiCall> = {}): ApiCall {
  return call({ ...p, ts, usage: { cache_read_input_tokens: prefix, cache_creation_input_tokens: fresh, output_tokens: output } });
}
