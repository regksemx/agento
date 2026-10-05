// Rebuilds, from the local transcripts, what tasks.jsonl deliberately does not keep: the raw prompts, the edit tool inputs,
// the files the session had modified before the task, and the token usage to reprice. Also re-reads the raw transcript for
// full prompts and full Edit/Write inputs (the parser cuts prompts at 4000 chars and tool-input strings at 1000).
// Nothing read here is written anywhere: prompts live in memory and go to `claude` on stdin.

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { repriceAs } from '../../../../plugin/core/cost.ts';
import type { TaskTier } from '../../../../plugin/core/task.ts';
import { segmentSession } from '../../audit/tasks.ts';
import type { Corpus, SessionData } from '../../types.ts';
import { taskId } from '../features.ts';
import type { TaskSource } from './types.ts';

const PARSER_PROMPT_MAX = 4000; // transcripts.ts PROMPT_MAX
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const TIERS: readonly TaskTier[] = ['haiku', 'sonnet', 'opus'];

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function buildSessionSources(s: SessionData): TaskSource[] {
  const out: TaskSource[] = [];
  for (const seg of segmentSession(s)) {
    const startTs = seg.summary.startTs;
    const prompts = s.prompts
      .filter((p) => !p.isSlashCommand && p.ts >= startTs && p.ts < seg.windowEnd)
      .map((p) => ({ uuid: p.uuid, text: p.text, truncated: p.text.length >= PARSER_PROMPT_MAX }));

    const edits: TaskSource['edits'] = [];
    const editToolUseIds: string[] = [];
    for (const c of seg.mainCalls) {
      for (const u of c.toolUses) {
        if (!EDIT_TOOLS.has(u.name)) continue;
        const i = obj(u.input);
        const path = str(i.file_path);
        if (!path) continue;
        editToolUseIds.push(u.id);
        const first = u.name === 'MultiEdit' && Array.isArray(i.edits) ? obj(i.edits[0]) : i;
        const oldString = str(first.old_string);
        edits.push({ ts: c.ts, tool: u.name, path, ...(oldString ? { oldString } : {}) });
      }
    }

    // files modified earlier in the session: Edit/Write calls before the task and the file-history rows
    const prior = new Map<string, number>();
    const note = (path: string, ts: number): void => void prior.set(path, Math.max(prior.get(path) ?? 0, ts));
    for (const c of s.calls) {
      if (c.lineage !== 'main' || c.ts >= startTs) continue;
      for (const u of c.toolUses) {
        if (!EDIT_TOOLS.has(u.name)) continue;
        const p = str(obj(u.input).file_path);
        if (p) note(p, c.ts);
      }
    }
    for (const h of s.fileHistory ?? []) for (const f of h.files) if (f.ts < startTs) note(f.path, f.ts);

    const repriced = { haiku: 0, sonnet: 0, opus: 0 } as Record<TaskTier, number>;
    for (const c of seg.windowCalls) for (const t of TIERS) repriced[t] += repriceAs(t, c.usage)?.total ?? 0;

    out.push({
      taskId: taskId(s.sessionId, startTs),
      sessionId: s.sessionId,
      projectDir: s.project,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
      startTs,
      windowEnd: seg.windowEnd,
      prompts,
      edits,
      editToolUseIds,
      priorTouched: [...prior.entries()].map(([path, ts]) => ({ path, ts })),
      repricedUsd: repriced,
    });
  }
  return out;
}

export function buildTaskSources(corpus: Corpus): Map<string, TaskSource> {
  const m = new Map<string, TaskSource>();
  for (const s of corpus.sessions) for (const src of buildSessionSources(s)) m.set(src.taskId, src);
  return m;
}

// ───────────────────────── neutral follow-ups ─────────────────────────

const NEUTRAL_WORDS = new Set(
  (
    'да ок окей окэй ага угу давай делай продолжай продолжи продолжить дальше далее хорошо ладно поехали го конечно верно отлично спасибо пожалуйста плиз ' +
    'ok okay yes yep yeah yup y sure go on ahead continue proceed next please thanks thx fine alright right do it ' +
    'lgtm'
  ).split(/\s+/),
);

// "да", "ок, продолжай", "yes please", "go on": a bare confirmation, nothing that changes the task.
export function isNeutralFollowUp(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.every((w) => NEUTRAL_WORDS.has(w) || w === '+');
}

// ───────────────────────── raw transcript ─────────────────────────

export function transcriptPath(projectsDir: string, src: { projectDir: string; sessionId: string }): string {
  return join(projectsDir, src.projectDir, `${src.sessionId}.jsonl`);
}

async function* rawRows(path: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(path, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const r: unknown = JSON.parse(line);
      if (typeof r === 'object' && r !== null) yield r as Record<string, unknown>;
    } catch {
      // damaged line
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? str((b as { text?: unknown }).text) : '')).filter(Boolean).join('\n');
}

// The task's human prompts in full. Prompts the parser cut at 4000 chars are re-read by uuid; failures fall back to the cut text.
export async function readFullPrompts(projectsDir: string, src: TaskSource): Promise<string[]> {
  const need = new Set(src.prompts.filter((p) => p.truncated).map((p) => p.uuid));
  const full = new Map<string, string>();
  const path = transcriptPath(projectsDir, src);
  if (need.size > 0 && existsSync(path)) {
    for await (const r of rawRows(path)) {
      if (r.type !== 'user' || typeof r.uuid !== 'string' || !need.has(r.uuid)) continue;
      const text = textOf(obj(r.message).content);
      if (text) full.set(r.uuid, text);
      if (full.size === need.size) break;
    }
  }
  return src.prompts.map((p) => full.get(p.uuid) ?? p.text);
}

export interface RawEdit {
  tool: string;
  input: Record<string, unknown>;
}

// Full (uncut) inputs of the task's Edit/Write/MultiEdit calls, in transcript order. Main line only: subagent edits live in
// other files and are not reconstructed.
export async function readRawEdits(projectsDir: string, src: TaskSource): Promise<RawEdit[]> {
  const want = new Set(src.editToolUseIds);
  const path = transcriptPath(projectsDir, src);
  if (want.size === 0 || !existsSync(path)) return [];
  const seen = new Set<string>();
  const out: RawEdit[] = [];
  for await (const r of rawRows(path)) {
    if (r.type !== 'assistant') continue;
    const content = obj(r.message).content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const blk = obj(b);
      if (blk.type !== 'tool_use' || typeof blk.id !== 'string' || !want.has(blk.id) || seen.has(blk.id)) continue;
      seen.add(blk.id);
      out.push({ tool: str(blk.name), input: obj(blk.input) });
    }
  }
  return out;
}

// A readable pseudo-diff of the original edits: "-" old lines, "+" new lines per Edit, "+" content per Write. Best effort:
// it shows what the agent wrote, not the exact resulting file. Paths are made relative to `root` when they sit inside it.
export function renderOriginalDiff(edits: readonly RawEdit[], root: string | undefined, maxChars = 30_000): string {
  const rel = (p: string): string => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
  const prefix = (t: string, mark: string): string => (t === '' ? '' : t.split('\n').map((l) => mark + l).join('\n') + '\n');
  const parts: string[] = [];
  for (const e of edits) {
    const file = rel(str(e.input.file_path));
    if (e.tool === 'Write') {
      parts.push(`--- ${file} (written)\n${prefix(str(e.input.content), '+')}`);
      continue;
    }
    const list = e.tool === 'MultiEdit' && Array.isArray(e.input.edits) ? e.input.edits.map(obj) : [e.input];
    for (const x of list) parts.push(`--- ${file}\n${prefix(str(x.old_string), '-')}${prefix(str(x.new_string), '+')}`);
  }
  const text = parts.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n[... cut]\n' : text;
}
