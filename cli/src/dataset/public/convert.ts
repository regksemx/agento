// TwinRouterBench `question_bank.jsonl` row -> agento PublicTaskRecord. Pure.
//
// A row is one routed STEP: `messages` is the router-visible prefix (OpenAI chat format: system / user / assistant with `tool_calls` /
// tool), `target_tier` is the cheapest tier that passed execution for the call that comes next. We render the prefix to plain text
// (long messages and the whole text are cut in the middle, keeping the start and the end).

import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, type PublicTaskRecord } from '../types.ts';
import { publicTierOf, TIER_ID, TIER_MAP } from './tier.ts';

export const TEXT_LIMIT = 6000; // chars of the stored prefix
const HEAD_SHARE = 0.4; // of the limit kept from the start; the rest from the end (the latest steps matter most)
const CHARS_PER_TOKEN = 3.6;

export type SkipReason = 'malformed' | 'no-messages' | 'bad-tier' | 'duplicate';

// Keeps the start and the end of `s`, `max` chars in total including the marker.
export function cutMiddle(s: string, max: number, headShare = HEAD_SHARE): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - 32); // room for the marker
  const head = Math.round(keep * headShare);
  return `${s.slice(0, head)}\n[… ${s.length - keep} chars cut …]\n${s.slice(s.length - (keep - head))}`;
}

interface Msg {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  function_call?: unknown;
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : JSON.stringify(b)))
      .join('\n');
  }
  return c === null || c === undefined ? '' : JSON.stringify(c);
}

function callText(c: unknown): string | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const fn = (c as { function?: unknown }).function ?? c;
  if (!fn || typeof fn !== 'object') return undefined;
  const name = (fn as { name?: unknown }).name;
  if (typeof name !== 'string') return undefined;
  const a = (fn as { arguments?: unknown }).arguments;
  const args = typeof a === 'string' ? a : a === undefined || a === null ? '' : JSON.stringify(a);
  return `→ ${name}(${cutMiddle(args, 500, 0.7)})`;
}

function messageText(m: Msg): string {
  const role = typeof m.role === 'string' ? m.role : 'unknown';
  const parts: string[] = [];
  const body = contentText(m.content).trim();
  if (body) parts.push(body);
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls : m.function_call ? [m.function_call] : [];
  for (const c of calls) {
    const t = callText(c);
    if (t) parts.push(t);
  }
  return `[${role}] ${parts.join('\n')}`.trimEnd();
}

function toolNames(functions: unknown): string | undefined {
  if (!Array.isArray(functions) || functions.length === 0) return undefined;
  const names = functions.map((f) => (f && typeof f === 'object' ? (f as { name?: unknown }).name : undefined)).filter((n): n is string => typeof n === 'string');
  if (names.length === 0) return undefined;
  return `[tools] ${cutMiddle(names.join(', '), 400)}`;
}

export interface RenderedPrefix {
  text: string;
  chars: number; // before the cut
  truncated: boolean;
}

// Per-message caps first (a huge tool output must not eat the room of the rest), then one cut of the whole text.
export function renderPrefix(messages: readonly Msg[], functions?: unknown): RenderedPrefix {
  const firstUser = messages.findIndex((m) => m.role === 'user');
  const last = messages.length - 1;
  const lines: string[] = [];
  const full: string[] = [];
  const tools = toolNames(functions);
  if (tools) {
    lines.push(tools);
    full.push(tools);
  }
  messages.forEach((m, i) => {
    const t = messageText(m);
    full.push(t);
    const cap = m.role === 'system' ? 600 : i === last ? 2400 : i === firstUser ? 1800 : 900;
    lines.push(cutMiddle(t, cap, i === last ? 0.3 : HEAD_SHARE));
  });
  const joined = lines.join('\n\n');
  const chars = full.join('\n\n').length;
  const text = cutMiddle(joined, TEXT_LIMIT);
  return { text, chars, truncated: text !== full.join('\n\n') };
}

export function taskIdOf(sourceId: string): string {
  return createHash('sha256').update('twinrouterbench:' + sourceId).digest('hex').slice(0, 16);
}

const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

export function convertRow(raw: unknown): PublicTaskRecord | { skip: SkipReason } {
  if (!raw || typeof raw !== 'object') return { skip: 'malformed' };
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  const benchmark = str(row.benchmark);
  if (!id || !benchmark) return { skip: 'malformed' };
  if (!Array.isArray(row.messages) || row.messages.length === 0) return { skip: 'no-messages' };
  const tier = publicTierOf(row);
  if (!tier) return { skip: 'bad-tier' };
  const stepIndex = num(row.step_index) ?? 1;
  const prefix = renderPrefix(row.messages as Msg[], row.functions);
  const rawChars = JSON.stringify(row.messages).length + (row.functions ? JSON.stringify(row.functions).length : 0);
  const subset = str(row.benchmark_subset);
  return {
    v: SCHEMA_VERSION,
    taskId: taskIdOf(id),
    source: 'twinrouterbench',
    project: `twinrouterbench/${benchmark}`,
    startTs: 0,
    text: [prefix.text],
    context: {
      contextTokensAtStart: Math.round(rawChars / CHARS_PER_TOKEN),
      startKind: stepIndex <= 1 ? 'first-prompt' : 'agent-step',
      languages: benchmark === 'swebench' ? ['py'] : [], // SWE-bench Verified is Python-only; the other workloads are not code-centric
      hasGitBranch: benchmark === 'swebench',
      prevTaskWasHeavy: false,
    },
    labelSource: 'L2-public',
    l2Tier: TIER_MAP[tier],
    l2Evidence: {
      publicTier: tier,
      publicTierId: TIER_ID[tier],
      benchmark,
      scenario: str(row.scenario) ?? 'unknown',
      instanceId: str(row.instance_id) ?? id,
      stepIndex,
      totalSteps: num(row.total_steps) ?? stepIndex,
      ...(subset ? { benchmarkSubset: subset } : {}),
      pipelineStage: str(row.pipeline_stage) ?? 'unknown',
      sourceId: id,
      prefixChars: prefix.chars,
      truncated: prefix.truncated,
      messages: row.messages.length,
    },
  };
}
