// Detects an agent that is stuck: the same test failing again and again, the same spot edited
// over and over, or a streak of failing tools. Pure logic; the mod feeds it from `tool.call`.

export interface ToolEvent {
  tool: string;
  input: unknown;
  isError: boolean;
  text?: string;
  at: number;
  lineage: string;
}

export type LoopKind = 'failing-test' | 'same-edit' | 'error-streak';

export interface LoopSignal {
  kind: LoopKind;
  count: number;
  detail: string;
}

export const LOOP_LIMITS = {
  failingTest: 3,
  sameEdit: 3,
  sameEditWindowSteps: 10,
  errorStreak: 4,
  // A signal of one kind in one lineage is not repeated for this many steps.
  cooldownSteps: 10,
} as const;

const TEST_RE = /(?:^|[\s;&|(])(?:test|pytest|jest|vitest|go\s+test|cargo\s+test|mvn|gradle|gradlew)(?=$|[\s;&|):])/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MIN_OVERLAP = 8; // chars a shared fragment needs before two edits count as "the same place"
const MIN_LINE = 12; // trimmed length of a shared line that counts as overlap
const MAX_EDIT_HISTORY = 40;

interface EditRecord {
  step: number;
  file: string;
  // The text this edit removed and put in. A later edit of the same place overlaps either.
  regions: string[];
  wholeFile: boolean;
}

interface LineageState {
  step: number;
  errorStreak: number;
  testFailures: Map<string, number>;
  edits: EditRecord[];
  lastSignalStep: Partial<Record<LoopKind, number>>;
}

const fresh = (): LineageState => ({ step: 0, errorStreak: 0, testFailures: new Map(), edits: [], lastSignalStep: {} });

export class LoopGuard {
  private lineages = new Map<string, LineageState>();

  push(e: ToolEvent): LoopSignal | null {
    let s = this.lineages.get(e.lineage);
    if (!s) this.lineages.set(e.lineage, (s = fresh()));
    s.step += 1;

    s.errorStreak = e.isError ? s.errorStreak + 1 : 0;

    const candidates: Array<LoopSignal | null> = [this.failingTest(s, e), this.sameEdit(s, e), this.errorStreak(s, e)];
    for (const c of candidates) {
      if (!c) continue;
      const last = s.lastSignalStep[c.kind];
      if (last !== undefined && s.step - last < LOOP_LIMITS.cooldownSteps) continue;
      s.lastSignalStep[c.kind] = s.step;
      return c;
    }
    return null;
  }

  // One lineage, or everything.
  reset(lineage?: string): void {
    if (lineage === undefined) this.lineages.clear();
    else this.lineages.delete(lineage);
  }

  private failingTest(s: LineageState, e: ToolEvent): LoopSignal | null {
    if (e.tool !== 'Bash') return null;
    const command = commandOf(e.input);
    if (!command || !TEST_RE.test(command)) return null;
    const key = normalizeCommand(command);
    if (!e.isError) {
      s.testFailures.delete(key);
      return null;
    }
    const count = (s.testFailures.get(key) ?? 0) + 1;
    s.testFailures.set(key, count);
    if (count < LOOP_LIMITS.failingTest) return null;
    return { kind: 'failing-test', count, detail: key };
  }

  private sameEdit(s: LineageState, e: ToolEvent): LoopSignal | null {
    if (!EDIT_TOOLS.has(e.tool)) return null;
    const rec = editRecord(e, s.step);
    if (!rec) return null;
    s.edits.push(rec);
    if (s.edits.length > MAX_EDIT_HISTORY) s.edits.splice(0, s.edits.length - MAX_EDIT_HISTORY);
    const windowStart = s.step - LOOP_LIMITS.sameEditWindowSteps + 1;
    const count = s.edits.filter((p) => p.step >= windowStart && p.file === rec.file && overlaps(p, rec)).length;
    if (count < LOOP_LIMITS.sameEdit) return null;
    return { kind: 'same-edit', count, detail: rec.file };
  }

  private errorStreak(s: LineageState, e: ToolEvent): LoopSignal | null {
    if (s.errorStreak < LOOP_LIMITS.errorStreak) return null;
    return { kind: 'error-streak', count: s.errorStreak, detail: e.tool };
  }
}

function commandOf(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const c = (input as { command?: unknown }).command;
    if (typeof c === 'string') return c;
  }
  return null;
}

// The same command run again, whatever the wrapping: whitespace, a leading `cd x &&`, output
// redirects and `| tail` style trimming do not make it a different command.
export function normalizeCommand(command: string): string {
  let c = command.trim().replace(/\s+/g, ' ');
  c = c.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '');
  c = c.replace(/\s*(?:\d?>&\d|\d?>\s*\S+)\s*/g, ' ');
  c = c.replace(/\s*\|\s*(?:tail|head|grep|tee|cat)\b[^|]*$/g, '');
  return c.replace(/\s+/g, ' ').trim();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function editRecord(e: ToolEvent, step: number): EditRecord | null {
  const input = e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : null;
  if (!input) return null;
  const file = str(input.file_path) || str(input.path);
  if (!file) return null;
  if (e.tool === 'Write') return { step, file, regions: [], wholeFile: true };
  const regions: string[] = [];
  const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : [input];
  for (const ed of edits) {
    if (!ed || typeof ed !== 'object') continue;
    const o = ed as Record<string, unknown>;
    if (str(o.old_string)) regions.push(str(o.old_string));
    if (str(o.new_string)) regions.push(str(o.new_string));
  }
  return { step, file, regions, wholeFile: regions.length === 0 };
}

function overlaps(a: EditRecord, b: EditRecord): boolean {
  if (a.wholeFile || b.wholeFile) return true;
  for (const x of a.regions) for (const y of b.regions) if (regionsOverlap(x, y)) return true;
  return false;
}

function regionsOverlap(x: string, y: string): boolean {
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= MIN_OVERLAP && long.includes(short)) return true;
  // A shared meaningful line: edits of the same block that grew or shrank around it.
  const lines = new Set(x.split('\n').map((l) => l.trim()).filter((l) => l.length >= MIN_LINE));
  if (lines.size === 0) return false;
  for (const l of y.split('\n')) if (lines.has(l.trim())) return true;
  return false;
}
