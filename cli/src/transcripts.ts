// Reads Claude Code transcripts (`<projects>/<project>/<session>.jsonl` and `.../<session>/subagents/**/agent-*.jsonl`)
// into a Corpus. Format notes live in cli/test/fixtures/README.md.

import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { normalizeUsage } from '../../plugin/core/cost.ts';
import { familyOf } from '../../plugin/core/pricing.ts';
import type {
  ApiCall,
  Corpus,
  CorpusStats,
  FileHistoryEntry,
  Lineage,
  MarkerKind,
  SessionData,
  SessionMarker,
  SubagentMeta,
  ToolResult,
  ToolUse,
  UserPrompt,
} from './types.ts';

const TOOL_RESULT_MAX = 2000;
const PROMPT_MAX = 4000;
const TOOL_INPUT_STRING_MAX = 1000;
const DESCRIPTION_MAX = 200;
const DEFAULT_CONCURRENCY = 8;

export interface LoadOptions {
  dir: string;
  since?: number; // epoch ms
  project?: string; // substring of the project directory name
  onProgress?: (done: number, total: number) => void;
}

export function resolveProjectsDir(flag?: string): string {
  if (flag) return flag;
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) return join(cfg, 'projects');
  return join(homedir(), '.claude', 'projects');
}

interface TranscriptFile {
  path: string;
  project: string;
  sessionId: string;
  lineage: Lineage;
  mtimeMs: number;
}

interface FileResult {
  file: TranscriptFile;
  calls: ApiCall[];
  callRows: Map<ApiCall, number>; // transcript rows each call was built from
  prompts: UserPrompt[];
  toolResults: ToolResult[];
  markers: SessionMarker[];
  fileHistory: FileHistoryEntry[];
  agent?: SubagentMeta; // from the `.meta.json` next to a subagent file
  cwd?: string;
  gitBranch?: string;
  reportedCostUSD?: number;
  lines: number;
  badLines: number;
  duplicateRows: number;
  syntheticCalls: number;
  filteredBySince: boolean;
}

type Row = Record<string, unknown>;

export async function loadCorpus(opts: LoadOptions): Promise<Corpus> {
  const started = Date.now();
  const files = await listFiles(opts);
  const results: Array<FileResult | undefined> = new Array(files.length);
  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const i = next++;
      const file = files[i]!;
      try {
        results[i] = await parseFile(file, opts.since);
      } catch {
        results[i] = undefined; // unreadable file: skip, never abort the audit
      }
      opts.onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DEFAULT_CONCURRENCY, files.length) }, worker));

  const corpus = merge(opts.dir, files.length, results.filter((r): r is FileResult => r !== undefined));
  corpus.stats.parseMs = Date.now() - started;
  return corpus;
}

async function listFiles(opts: LoadOptions): Promise<TranscriptFile[]> {
  let projects: string[];
  try {
    projects = (await readdir(opts.dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    throw new Error(`Projects directory not found or unreadable: ${opts.dir}`);
  }
  const needle = opts.project?.toLowerCase();
  const out: TranscriptFile[] = [];

  const add = async (path: string, project: string, sessionId: string, lineage: Lineage): Promise<void> => {
    try {
      const mtimeMs = (await stat(path)).mtimeMs;
      if (opts.since !== undefined && mtimeMs < opts.since) return;
      out.push({ path, project, sessionId, lineage, mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  };

  const walkSubagents = async (dir: string, project: string, sessionId: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walkSubagents(p, project, sessionId);
      else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) {
        await add(p, project, sessionId, `agent:${e.name.slice(6, -6)}`);
      }
    }
  };

  await Promise.all(
    projects
      .filter((p) => !needle || p.toLowerCase().includes(needle))
      .map(async (project) => {
        const pdir = join(opts.dir, project);
        let entries;
        try {
          entries = await readdir(pdir, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          entries.map(async (e) => {
            if (e.isFile() && e.name.endsWith('.jsonl')) await add(join(pdir, e.name), project, e.name.slice(0, -6), 'main');
            else if (e.isDirectory()) await walkSubagents(join(pdir, e.name, 'subagents'), project, e.name);
          }),
        );
      }),
  );
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ───────────────────────── per-file parsing ─────────────────────────

interface Pending {
  call: ApiCall;
  rows: number;
  toolIds: Set<string>;
}

async function parseFile(file: TranscriptFile, since: number | undefined): Promise<FileResult> {
  const isMain = file.lineage === 'main';
  const res: FileResult = {
    file,
    calls: [],
    callRows: new Map(),
    prompts: [],
    toolResults: [],
    markers: [],
    fileHistory: [],
    lines: 0,
    badLines: 0,
    duplicateRows: 0,
    syntheticCalls: 0,
    filteredBySince: false,
  };
  if (!isMain) res.agent = await readAgentMeta(file.path);
  const pending = new Map<string, Pending>();
  const pendingMarker: Partial<Record<MarkerKind, SessionMarker>> = {};
  let costState: number | undefined;

  const rl = createInterface({ input: createReadStream(file.path, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    res.lines++;
    let row: Row;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) throw new Error('not an object');
      row = parsed;
    } catch {
      res.badLines++;
      continue;
    }
    const type = row.type;
    if (type === 'assistant') onAssistant(row, file, res, pending);
    else if (type === 'user') onUser(row, file, isMain, res, pendingMarker);
    else if (type === 'system') onSystem(row, file, isMain, res, pendingMarker);
    else if ((type === 'file-history-snapshot' || type === 'file-history-delta') && isMain) onFileHistory(row, res);
    else if (type === 'cost-state' && isMain) {
      const c = row.totalCostUSD;
      if (typeof c === 'number' && Number.isFinite(c)) costState = c;
    }
    if (isMain && res.cwd === undefined && (type === 'user' || type === 'assistant')) {
      if (typeof row.cwd === 'string') res.cwd = row.cwd;
      if (typeof row.gitBranch === 'string' && row.gitBranch) res.gitBranch = row.gitBranch;
    }
  }

  for (const p of pending.values()) {
    res.callRows.set(p.call, p.rows);
    res.calls.push(p.call);
  }
  res.reportedCostUSD = costState;

  if (since !== undefined) {
    const keep = <T extends { ts: number }>(xs: T[]): T[] => {
      const kept = xs.filter((x) => x.ts >= since);
      if (kept.length !== xs.length) res.filteredBySince = true;
      return kept;
    };
    res.calls = keep(res.calls);
    res.prompts = keep(res.prompts);
    res.toolResults = keep(res.toolResults);
    res.markers = keep(res.markers);
    res.fileHistory = keep(res.fileHistory);
  }
  return res;
}

// `agent-<id>.jsonl` has `agent-<id>.meta.json` beside it: {"agentType": "...", "description": "...", ...}.
async function readAgentMeta(transcriptPath: string): Promise<SubagentMeta | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    if (!isObject(parsed) || typeof parsed.agentType !== 'string' || !parsed.agentType) return undefined;
    const meta: SubagentMeta = { type: parsed.agentType };
    if (typeof parsed.description === 'string' && parsed.description) meta.description = parsed.description.slice(0, DESCRIPTION_MAX);
    return meta;
  } catch {
    return undefined; // no meta file (older builds) or unreadable: the type stays unknown
  }
}

// `file-history-snapshot` (older builds: `snapshot.trackedFileBackups` = every file Claude edited so far, with the time of its
// latest backup) and `file-history-delta` (newer builds: one row per backed-up file). Both say which files the session had
// modified by a given time; `dataset replay` uses that to tell whether the working tree was dirty when a task began.
function onFileHistory(row: Row, res: FileResult): void {
  if (row.type === 'file-history-delta') {
    const path = row.trackingPath;
    const backup = isObject(row.backup) ? row.backup : {};
    const ts = parseTs(backup.backupTime) ?? parseTs(row.timestamp);
    if (typeof path === 'string' && path && ts !== undefined) res.fileHistory.push({ ts, kind: 'delta', files: [{ path, ts }] });
    return;
  }
  const snap = row.snapshot;
  if (!isObject(snap) || !isObject(snap.trackedFileBackups)) return;
  const snapTs = parseTs(snap.timestamp);
  const files: Array<{ path: string; ts: number }> = [];
  for (const [path, b] of Object.entries(snap.trackedFileBackups)) {
    const ts = (isObject(b) ? parseTs(b.backupTime) : undefined) ?? snapTs;
    if (ts !== undefined) files.push({ path, ts });
  }
  if (files.length > 0 && snapTs !== undefined) res.fileHistory.push({ ts: snapTs, kind: 'snapshot', files });
}

function onAssistant(row: Row, file: TranscriptFile, res: FileResult, pending: Map<string, Pending>): void {
  const msg = row.message;
  if (!isObject(msg)) return;
  const ts = parseTs(row.timestamp);
  if (ts === undefined) {
    res.badLines++;
    return;
  }
  const model = typeof msg.model === 'string' ? msg.model : '';
  if (model === '<synthetic>') {
    res.syntheticCalls++;
    return;
  }
  if (!isObject(msg.usage)) return;
  const usage = normalizeUsage(msg.usage as never);
  const requestId = typeof row.requestId === 'string' ? row.requestId : undefined;
  // Without a message id the row cannot be deduplicated: treat it as its own request.
  const messageId = typeof msg.id === 'string' && msg.id ? msg.id : `row:${String(row.uuid ?? res.lines)}`;
  const key = `${messageId}|${requestId ?? ''}`;

  const toolUses = extractToolUses(msg.content);
  const prev = pending.get(key);
  const effort = typeof row.effort === 'string' ? row.effort : typeof row.perTurnEffort === 'string' ? row.perTurnEffort : undefined;
  const call: ApiCall = {
    messageId,
    requestId,
    sessionId: file.sessionId,
    project: file.project,
    lineage: file.lineage,
    ts,
    model,
    usage,
    effort,
    speed: usage.speed ?? null,
    isSidechain: row.isSidechain === true || file.lineage !== 'main',
    toolUses,
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
  };
  if (prev) {
    // One row per content block, usage repeated: the last row has the final output_tokens; tool uses are spread across rows.
    const seen = prev.toolIds;
    const merged = [...prev.call.toolUses];
    for (const t of toolUses) if (!seen.has(t.id)) (seen.add(t.id), merged.push(t));
    call.toolUses = merged;
    call.stopReason = call.stopReason ?? prev.call.stopReason;
    call.effort = call.effort ?? prev.call.effort;
    prev.call = call;
    prev.rows++;
    res.duplicateRows++;
  } else {
    pending.set(key, { call, rows: 1, toolIds: new Set(toolUses.map((t) => t.id)) });
  }
}

function extractToolUses(content: unknown): ToolUse[] {
  if (!Array.isArray(content)) return [];
  const out: ToolUse[] = [];
  for (const b of content) {
    if (!isObject(b) || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
    out.push({ id: typeof b.id === 'string' ? b.id : '', name: b.name, input: slim(b.input, 0) });
  }
  return out;
}

// Keeps tool inputs small: long strings (file contents, diffs) are cut, structure is preserved.
function slim(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > TOOL_INPUT_STRING_MAX ? v.slice(0, TOOL_INPUT_STRING_MAX) : v;
  if (depth >= 3) return typeof v === 'object' && v !== null ? null : v;
  if (Array.isArray(v)) return v.map((x) => slim(x, depth + 1));
  if (isObject(v)) {
    const out: Row = {};
    for (const [k, x] of Object.entries(v)) out[k] = slim(x, depth + 1);
    return out;
  }
  return v;
}

const NON_PROMPT_TAGS = ['<local-command-', '<bash-', '<task-notification', '<system-reminder', '<command-message'];

function onUser(row: Row, file: TranscriptFile, isMain: boolean, res: FileResult, pendingMarker: Partial<Record<MarkerKind, SessionMarker>>): void {
  const msg = row.message;
  if (!isObject(msg)) return;
  const ts = parseTs(row.timestamp);
  if (ts === undefined) {
    res.badLines++;
    return;
  }
  const content = msg.content;

  if (Array.isArray(content)) {
    let hadResult = false;
    for (const b of content) {
      if (!isObject(b) || b.type !== 'tool_result') continue;
      hadResult = true;
      res.toolResults.push({
        sessionId: file.sessionId,
        lineage: file.lineage,
        ts,
        toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
        isError: b.is_error === true,
        text: resultText(b.content).slice(0, TOOL_RESULT_MAX),
      });
    }
    if (hadResult) return;
  }
  // Subagent files start with the parent's task text: that is not something the human typed.
  if (!isMain) return;
  if (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return;
  const origin = row.origin;
  if (isObject(origin) && origin.kind !== 'human') return;
  if (row.promptSource === 'system') return;

  const text = userText(content);
  if (!text) return;
  const head = text.trimStart();

  const cmd = /^<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(head);
  if (cmd) {
    const name = cmd[1]!.startsWith('/') ? cmd[1]! : `/${cmd[1]!}`;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(head)?.[1]?.trim() ?? '';
    onCommand(name, args, ts, file.sessionId, res, pendingMarker);
    res.prompts.push(prompt(row, file, ts, args ? `${name} ${args}` : name, true));
    return;
  }
  if (head.startsWith('<local-command-stdout>')) {
    onCommandOutput(head, ts, file.sessionId, res, pendingMarker);
    return;
  }
  if (NON_PROMPT_TAGS.some((t) => head.startsWith(t))) return;
  if (head.startsWith('[Request interrupted')) return;
  res.prompts.push(prompt(row, file, ts, text, head.startsWith('/')));
}

function prompt(row: Row, file: TranscriptFile, ts: number, text: string, isSlashCommand: boolean): UserPrompt {
  return {
    uuid: typeof row.uuid === 'string' ? row.uuid : '',
    sessionId: file.sessionId,
    project: file.project,
    ts,
    text: text.slice(0, PROMPT_MAX),
    isSlashCommand,
  };
}

function onSystem(row: Row, file: TranscriptFile, isMain: boolean, res: FileResult, pendingMarker: Partial<Record<MarkerKind, SessionMarker>>): void {
  if (!isMain) return;
  const ts = parseTs(row.timestamp);
  if (ts === undefined) return;
  const sub = row.subtype;
  const mark = (kind: MarkerKind, detail?: string): SessionMarker => {
    const m: SessionMarker = { sessionId: file.sessionId, ts, kind, detail };
    res.markers.push(m);
    return m;
  };
  if (sub === 'compact_boundary') {
    const meta = isObject(row.compactMetadata) ? row.compactMetadata : {};
    mark('compact', typeof meta.trigger === 'string' ? meta.trigger : undefined);
  } else if (sub === 'away_summary') {
    mark('away');
  } else if (sub === 'model_refusal_fallback') {
    mark('other', 'model_refusal_fallback');
  } else if (sub === 'local_command' && typeof row.content === 'string') {
    const cmd = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(row.content);
    if (cmd) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(row.content)?.[1]?.trim() ?? '';
      onCommand(cmd[1]!.startsWith('/') ? cmd[1]! : `/${cmd[1]!}`, args, ts, file.sessionId, res, pendingMarker);
    } else if (row.content.includes('<local-command-stdout>')) {
      onCommandOutput(row.content, ts, file.sessionId, res, pendingMarker);
    }
  }
}

// /clear, /model and /effort are markers; /compact is marked by its compact_boundary row instead.
function onCommand(name: string, args: string, ts: number, sessionId: string, res: FileResult, pendingMarker: Partial<Record<MarkerKind, SessionMarker>>): void {
  const kind: MarkerKind | undefined = name === '/clear' ? 'clear' : name === '/model' ? 'model' : name === '/effort' ? 'effort' : undefined;
  if (!kind) return;
  const m: SessionMarker = { sessionId, ts, kind, detail: args || undefined };
  res.markers.push(m);
  if (kind !== 'clear') pendingMarker[kind] = m;
}

// The command's result row names the model/effort actually set ("Set model to `X`", "Set effort level to high ...").
function onCommandOutput(text: string, ts: number, sessionId: string, res: FileResult, pendingMarker: Partial<Record<MarkerKind, SessionMarker>>): void {
  const model = /Set model to\s+`([^`]+)`/.exec(text)?.[1];
  const effort = /Set effort level to\s+([a-z]+)/i.exec(text)?.[1]?.toLowerCase();
  const attach = (kind: MarkerKind, detail: string): void => {
    const m = pendingMarker[kind];
    if (m && ts - m.ts < 60_000) m.detail = detail;
    else res.markers.push({ sessionId, ts, kind, detail });
    delete pendingMarker[kind];
  };
  if (model) attach('model', model);
  else if (effort) attach('effort', effort);
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) if (isObject(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) if (isObject(b) && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n');
}

// ───────────────────────── merging ─────────────────────────

function merge(dir: string, fileCount: number, results: FileResult[]): Corpus {
  const stats: CorpusStats = { files: fileCount, lines: 0, badLines: 0, duplicateRows: 0, unknownModelCalls: 0, parseMs: 0 };
  const sessions = new Map<string, SessionData>();
  const costUnreliable = new Set<string>();
  // Resumed and forked sessions copy earlier rows into new files: one request must be counted once.
  const seen = new Map<string, { call: ApiCall; rows: number; owner: SessionData }>();

  for (const r of results) {
    stats.lines += r.lines;
    stats.badLines += r.badLines;
    stats.duplicateRows += r.duplicateRows;
    stats.unknownModelCalls += r.syntheticCalls;

    const sid = r.file.sessionId;
    let s = sessions.get(sid);
    if (!s) {
      s = { sessionId: sid, project: r.file.project, firstTs: 0, lastTs: 0, calls: [], prompts: [], toolResults: [], markers: [], agents: {} };
      sessions.set(sid, s);
    }
    if (r.file.lineage === 'main') {
      s.project = r.file.project;
      s.cwd = r.cwd ?? s.cwd;
      s.gitBranch = r.gitBranch ?? s.gitBranch;
      s.reportedCostUSD = r.reportedCostUSD ?? s.reportedCostUSD;
      if (r.filteredBySince) costUnreliable.add(sid);
    } else {
      if (r.agent) s.agents[r.file.lineage.slice('agent:'.length)] = r.agent;
      if (r.filteredBySince) costUnreliable.add(sid);
    }

    for (const call of r.calls) {
      const rows = r.callRows.get(call) ?? 1;
      const key = `${call.messageId}|${call.requestId ?? ''}`;
      const prev = call.messageId.startsWith('row:') ? undefined : seen.get(key);
      if (!prev) {
        s.calls.push(call);
        seen.set(key, { call, rows, owner: s });
        continue;
      }
      // Keep the fuller copy (larger output), then prefer the main-thread one.
      const better =
        call.usage.output_tokens > prev.call.usage.output_tokens ||
        (call.usage.output_tokens === prev.call.usage.output_tokens && call.lineage === 'main' && prev.call.lineage !== 'main');
      stats.duplicateRows += rows;
      if (better) {
        prev.owner.calls = prev.owner.calls.filter((c) => c !== prev.call);
        s.calls.push(call);
        seen.set(key, { call, rows, owner: s });
      }
    }
    s.prompts.push(...r.prompts);
    s.toolResults.push(...r.toolResults);
    s.markers.push(...r.markers);
    if (r.fileHistory.length > 0 && r.file.lineage === 'main') (s.fileHistory ??= []).push(...r.fileHistory);
  }

  const out: SessionData[] = [];
  for (const s of sessions.values()) {
    s.calls.sort((a, b) => a.ts - b.ts);
    s.prompts.sort((a, b) => a.ts - b.ts);
    s.toolResults.sort((a, b) => a.ts - b.ts);
    s.markers.sort((a, b) => a.ts - b.ts);
    s.fileHistory?.sort((a, b) => a.ts - b.ts);
    if (costUnreliable.has(s.sessionId)) s.reportedCostUSD = undefined;
    if (s.calls.length === 0 && s.prompts.length === 0) continue;
    const times = [...s.calls, ...s.prompts, ...s.toolResults, ...s.markers].map((x) => x.ts);
    s.firstTs = times.reduce((a, b) => Math.min(a, b), Infinity);
    s.lastTs = times.reduce((a, b) => Math.max(a, b), -Infinity);
    for (const c of s.calls) if (familyOf(c.model) === 'unknown') stats.unknownModelCalls++;
    out.push(s);
  }
  out.sort((a, b) => a.firstTs - b.firstTs || (a.sessionId < b.sessionId ? -1 : 1));
  return { dir, sessions: out, stats };
}

// ───────────────────────── helpers ─────────────────────────

function isObject(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
