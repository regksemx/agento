// Turns a session into dataset records: scrubbed text, context, observed trajectory, L0 labels.

import { createHash } from 'node:crypto';
import { prefixTokens } from '../../../plugin/core/cost.ts';
import { tierOf } from '../../../plugin/core/pricing.ts';
import { classifyRules, extractFeatures, isTaskStart } from '../../../plugin/core/task.ts';
import { IDLE_BOUNDARY_MS, segmentSession, type TaskSegment } from '../audit/tasks.ts';
import { tildify } from '../report/format.ts';
import type { ApiCall, SessionData, ToolUse, UserPrompt } from '../types.ts';
import { l0Label } from './l0.ts';
import { addHits, emptyHits, scrub, type ScrubHits } from './scrub.ts';
import { SCHEMA_VERSION, type StartKind, type TaskObserved, type TaskRecord } from './types.ts';

export const PROMPT_MAX_CHARS = 1500;
export const FOLLOW_UPS_MAX = 3;
export const LANGUAGES_MAX = 3;

// ───────────────────────── patterns ─────────────────────────

// Follow-up prompts that push back on the previous answer (ru + en).
const CORRECTION_RE =
  /(?<![\p{L}\p{N}_])(?:нет|не так|не то|неправильн\p{L}*|откат\p{L}*|верни\p{L}*|revert\p{L}*|wrong|stop)(?![\p{L}\p{N}_])|that['’]s not|\[request interrupted/iu;

export function isCorrection(text: string): boolean {
  return CORRECTION_RE.test(text);
}

const TEST_CMD_RE =
  /(?<![\w-])(?:vitest|jest|pytest|mocha|phpunit|rspec|tox|nosetests|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|cargo\s+(?:test|nextest)|go\s+test|dotnet\s+test|deno\s+test|mvn\s+(?:\S+\s+)*?test|(?:\.\/)?gradlew?\s+(?:\S+\s+)*?test|swift\s+test|ctest|python\d?\s+-m\s+(?:pytest|unittest)|make\s+test|npx\s+(?:vitest|jest|playwright\s+test))(?![\w-])/i;

export function isTestCommand(cmd: string): boolean {
  return TEST_CMD_RE.test(cmd);
}

const INTERRUPT_RE = /doesn['’]t want to proceed|\[request interrupted/i;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep']);

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift',
  rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', m: 'objc',
  sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', html: 'html', css: 'css', scss: 'css', vue: 'vue', svelte: 'svelte',
  lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir', hs: 'haskell', gradle: 'gradle', tf: 'terraform',
};

// ───────────────────────── helpers ─────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function lineCount(s: string): number {
  return s === '' ? 0 : s.split('\n').length;
}

export function taskId(sessionId: string, startTs: number): string {
  return createHash('sha256').update(`agento:${sessionId}:${startTs}`).digest('hex').slice(0, 16);
}

// "~/Projects/x" for the session's cwd; the transcript directory name ("-Users-me-Projects-x") only as a fallback.
export function projectLabel(s: SessionData): string {
  if (s.cwd) return scrub(tildify(s.cwd)).text;
  return s.project.replace(/^-(?:Users|home)-[^-]+/, '~');
}

function startKindOf(s: SessionData, p: UserPrompt): StartKind {
  const human = s.prompts.filter((x) => !x.isSlashCommand);
  const idx = human.indexOf(p);
  const prev = idx > 0 ? (human[idx - 1] as UserPrompt) : undefined;
  let lastMain: number | null = null;
  for (const c of s.calls) if (c.lineage === 'main' && c.ts < p.ts) lastMain = c.ts;
  let marker: 'compact' | 'clear' | null = null;
  if (prev) {
    for (const m of s.markers) if ((m.kind === 'compact' || m.kind === 'clear') && m.ts > prev.ts && m.ts <= p.ts) marker = m.kind;
  }
  const reason = isTaskStart({
    isFirstPrompt: prev === undefined,
    markerSinceLastPrompt: marker,
    msSinceLastMainCall: lastMain === null ? null : p.ts - lastMain,
    ttlMs: IDLE_BOUNDARY_MS,
    explicitNew: false,
  });
  return reason === 'compact' || reason === 'clear' || reason === 'first-prompt' ? reason : 'idle';
}

function toolUses(calls: ApiCall[]): ToolUse[] {
  return calls.flatMap((c) => c.toolUses);
}

// Editing work: lines added + removed (Edit: old + new, Write: content) and edits that redo an earlier edit.
// Tool inputs are stored cut at 1000 chars per string by the transcript parser, so big edits are undercounted.
function editStats(uses: ToolUse[]): { linesChanged: number; sameEditRepeats: number } {
  let linesChanged = 0;
  let repeats = 0;
  const olds = new Set<string>(); // file \0 old_string
  const news = new Map<string, string[]>(); // file -> new strings written so far
  const written = new Set<string>(); // files fully written
  for (const u of uses) {
    if (!EDIT_TOOLS.has(u.name)) continue;
    const i = obj(u.input);
    const file = str(i.file_path) || str(i.notebook_path);
    if (u.name === 'Write') {
      linesChanged += lineCount(str(i.content));
      if (written.has(file)) repeats += 1;
      written.add(file);
      continue;
    }
    const edits = u.name === 'MultiEdit' && Array.isArray(i.edits) ? i.edits.map(obj) : [i];
    for (const e of edits) {
      const oldS = str(e.old_string);
      const newS = str(e.new_string) || str(e.new_source);
      linesChanged += lineCount(oldS) + lineCount(newS);
      const key = `${file}\0${oldS}`;
      const earlier = news.get(file) ?? [];
      if ((oldS && olds.has(key)) || (oldS.length >= 8 && earlier.some((n) => n.includes(oldS)))) repeats += 1;
      if (oldS) olds.add(key);
      earlier.push(newS);
      news.set(file, earlier);
    }
  }
  return { linesChanged, sameEditRepeats: repeats };
}

function topLanguages(uses: ToolUse[]): string[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const u of uses) {
    if (!PATH_TOOLS.has(u.name)) continue;
    const i = obj(u.input);
    const path = str(i.file_path) || str(i.notebook_path) || str(i.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
    const lang = ext ? EXT_LANG[ext] : undefined;
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, LANGUAGES_MAX)
    .map(([l]) => l);
}

// ───────────────────────── records ─────────────────────────

export interface SessionRecords {
  records: TaskRecord[];
  hits: ScrubHits;
}

export function buildSessionRecords(s: SessionData): SessionRecords {
  const hits = emptyHits();
  const segments = segmentSession(s);
  const records: TaskRecord[] = [];
  const results = new Map<string, boolean>(); // tool_use id -> isError
  for (const r of s.toolResults) results.set(r.toolUseId, r.isError);
  let prevHeavy = false;

  for (const seg of segments) {
    const rec = buildRecord(s, seg, results, prevHeavy, hits);
    prevHeavy = rec.l0Tier === 'opus';
    records.push(rec);
  }
  return { records, hits };
}

function buildRecord(s: SessionData, seg: TaskSegment, results: Map<string, boolean>, prevHeavy: boolean, hits: ScrubHits): TaskRecord {
  const sum = seg.summary;
  const startTs = sum.startTs;
  const humanPrompts = s.prompts.filter((p) => !p.isSlashCommand && p.ts >= startTs && p.ts < seg.windowEnd);
  const followUps = humanPrompts.filter((p) => p !== seg.prompt);
  const uses = toolUses(seg.windowCalls);
  const mainUses = toolUses(seg.mainCalls);

  const text = [seg.prompt, ...followUps.slice(0, FOLLOW_UPS_MAX)].map((p) => {
    const r = scrub(p.text);
    addHits(hits, r.hits);
    return r.text.slice(0, PROMPT_MAX_CHARS); // scrub first, cut after: a cut must never split a secret
  });

  const subCalls = seg.windowCalls.filter((c) => c.lineage !== 'main');
  const subTypes = new Set(subCalls.map((c) => s.agents[c.lineage.slice('agent:'.length)]?.type ?? 'unknown'));
  const tests = uses.filter((u) => u.name === 'Bash' && isTestCommand(str(obj(u.input).command)));
  const interrupts = s.toolResults.filter((r) => r.ts >= startTs && r.ts < seg.windowEnd && INTERRUPT_RE.test(r.text)).length;
  const edits = editStats(uses);

  const observed: TaskObserved = {
    model: sum.model,
    modelTier: tierOf(sum.model) ?? 'unknown',
    ...(sum.effort ? { effort: sum.effort } : {}),
    mainCalls: sum.mainCalls,
    subagentCalls: subCalls.length,
    subagentTypes: [...subTypes].sort(),
    filesEdited: sum.filesEdited,
    linesChanged: edits.linesChanged,
    toolErrors: sum.errors,
    testRuns: tests.length,
    testFailures: tests.filter((u) => results.get(u.id) === true).length,
    sameEditRepeats: edits.sameEditRepeats,
    userCorrections: followUps.filter((p) => isCorrection(p.text)).length,
    userInterrupts: interrupts,
    planMode: mainUses.some((u) => u.name === 'ExitPlanMode'),
    durationMs: Math.max(0, sum.endTs - startTs),
    outputTokens: sum.outputTokens,
    cost: Math.round(sum.cost * 1e6) / 1e6,
  };

  const startKind = startKindOf(s, seg.prompt);
  const contextTokensAtStart = prefixTokens((seg.mainCalls[0] as ApiCall).usage);
  const label = l0Label(observed, seg.prompt.text);
  const features = extractFeatures(seg.prompt.text, { contextTokens: contextTokensAtStart, isSessionStart: startKind === 'first-prompt' });


  return {
    v: SCHEMA_VERSION,
    taskId: taskId(s.sessionId, startTs),
    project: projectLabel(s),
    startTs,
    text,
    context: {
      contextTokensAtStart,
      startKind,
      languages: topLanguages(uses),
      hasGitBranch: Boolean(s.gitBranch),
      prevTaskWasHeavy: prevHeavy,
    },
    observed,
    difficulty: label.difficulty,
    l0Tier: label.tier,
    l0Effort: label.effort,
    rulesVerdict: classifyRules(features),
    labelSource: 'L0',
  };
}
