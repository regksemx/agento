// Replaces tool outputs superseded by a later identical call with a stub.
// Used right before a compaction: pruning a warm prefix mid-task would force a full cache rewrite.

import { priceOf } from './pricing.ts';

export interface PruneToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface PruneToolResult {
  tool_use_id: string;
  text: string;
  isError: boolean;
  result?: unknown;
}

// Subset of SessionMessage.
export interface PruneMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly PruneToolUse[];
  toolResults?: readonly PruneToolResult[];
  handle?: string;
}

export interface PrunePlan<M extends PruneMessage> {
  messages: M[];
  pruned: number;
  chars: number;
}

export const KEEP_LAST_MESSAGES = 12;
export const MIN_RESULT_CHARS = 1500;

export const charsToTokens = (chars: number): number => Math.round(chars / 4);

export function stubText(tool: string): string {
  return `[agento: an older output of this ${tool} call was pruned: a later identical call superseded it]`;
}

// null: never pruned
export function supersedeKey(u: PruneToolUse): string | null {
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : v === undefined ? '' : JSON.stringify(v));
  switch (u.tool) {
    case 'Read':
      return typeof u.input.file_path === 'string' ? `read:${u.input.file_path}:${s(u.input.offset)}:${s(u.input.limit)}` : null;
    case 'Bash':
      return typeof u.input.command === 'string' && u.input.command.trim() ? `bash:${u.input.command.trim()}` : null;
    case 'Grep':
    case 'Glob':
      return `${u.tool}:${JSON.stringify(u.input)}`;
    default:
      return null;
  }
}

// Changed messages drop their handle so the engine rebuilds them.
export function planPrune<M extends PruneMessage>(messages: readonly M[], keepLast = KEEP_LAST_MESSAGES, minResultChars = MIN_RESULT_CHARS): PrunePlan<M> {
  const uses = new Map<string, PruneToolUse>();
  for (const m of messages) for (const u of m.toolUses ?? []) uses.set(u.tool_use_id, u);
  const seen = new Set<string>();
  const out: M[] = [...messages];
  let pruned = 0;
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as M;
    const results = m.toolResults;
    if (!results || results.length === 0) continue;
    const protectedMsg = i >= messages.length - keepLast;
    let changed = false;
    const next = results.map((r) => {
      const u = uses.get(r.tool_use_id);
      const key = u ? supersedeKey(u) : null;
      if (!u || key === null) return r;
      const superseded = seen.has(key);
      seen.add(key);
      if (protectedMsg || !superseded || r.text.length < minResultChars || r.text.startsWith('[agento:')) return r;
      const stub = stubText(u.tool);
      changed = true;
      pruned += 1;
      chars += r.text.length - stub.length;
      return { tool_use_id: r.tool_use_id, text: stub, isError: r.isError };
    });
    if (changed) {
      const { handle: _engine, ...rest } = m;
      out[i] = { ...rest, toolResults: next } as unknown as M;
    }
  }
  return { messages: out, pruned, chars };
}

// Before a compaction the summarizer reads them as plain input.
export function compactPruneSaving(model: string, tokens: number): number | null {
  const p = priceOf(model);
  return p ? (tokens * p.input) / 1_000_000 : null;
}
