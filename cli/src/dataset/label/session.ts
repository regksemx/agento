// The labeling session: a pure keypress state machine (`reduce`), a key parser for raw-mode input (`parseKeys`) and the
// terminal driver (`runSession`). Single keypress per question, no Enter needed; arrows move a highlight, Enter confirms it.

import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';
import type { Answers } from './store.ts';
import { EFFORTS, TIERS } from './types.ts';

export type Step = 'tier' | 'effort' | 'plan' | 'delegate';
export const STEPS: readonly Step[] = ['tier', 'effort', 'plan', 'delegate'];

export type Key =
  | { k: 'char'; ch: string }
  | { k: 'left' | 'right' | 'up' | 'down' | 'enter' | 'backspace' | 'esc' | 'ctrl-c' };

export interface SessionState {
  index: number; // current card
  total: number;
  step: Step;
  answers: Partial<Answers>;
  cursor: number | null; // arrow highlight in the current question
  expanded: boolean; // full prompt
  guesses: boolean; // L0/rules/L1 guesses revealed
  status: 'running' | 'done' | 'quit';
  saved: number; // verdicts written in this session (full or "don't remember")
  skipped: number;
}

export type Effect = { type: 'save'; index: number; answers: Answers | 'unsure' };

export function initialState(total: number): SessionState {
  return { index: 0, total, step: 'tier', answers: {}, cursor: null, expanded: false, guesses: false, status: total > 0 ? 'running' : 'done', saved: 0, skipped: 0 };
}

export function optionCount(step: Step): number {
  return step === 'tier' || step === 'effort' ? 3 : 2;
}

// Cyrillic keys of a Russian layout map to the Latin key at the same place, so shortcuts work without switching layout.
const LAYOUT: Record<string, string> = { й: 'q', и: 'b', п: 'g', у: 'e', ы: 's', н: 'y', т: 'n' };
export function normalizeChar(ch: string): string {
  const lower = ch.toLowerCase();
  return LAYOUT[lower] ?? lower;
}

// Splits a chunk of raw stdin into keys. Handles CSI/SS3 arrows and keeps unknown escape sequences from becoming characters.
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < chunk.length; ) {
    const c = chunk[i]!;
    if (c === '\x1b') {
      const m = /^\x1b(?:\[|O)([0-9;]*)([A-Za-z~])/.exec(chunk.slice(i));
      if (m) {
        const name = ({ A: 'up', B: 'down', C: 'right', D: 'left' } as const)[m[2] as 'A'];
        if (name) keys.push({ k: name });
        i += m[0].length;
      } else {
        keys.push({ k: 'esc' });
        i += 1;
      }
    } else if (c === '\x03') {
      keys.push({ k: 'ctrl-c' });
      i += 1;
    } else if (c === '\r' || c === '\n') {
      keys.push({ k: 'enter' });
      i += c === '\r' && chunk[i + 1] === '\n' ? 2 : 1;
    } else if (c === '\x7f' || c === '\b') {
      keys.push({ k: 'backspace' });
      i += 1;
    } else if (c < ' ') {
      i += 1; // other control characters
    } else {
      const cp = chunk.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      keys.push({ k: 'char', ch });
      i += ch.length;
    }
  }
  return keys;
}

function advance(s: SessionState): SessionState {
  const index = s.index + 1;
  return { ...s, index, step: 'tier', answers: {}, cursor: null, expanded: false, guesses: false, status: index >= s.total ? 'done' : 'running' };
}

function answer(s: SessionState, choice: number): { state: SessionState; effect?: Effect } {
  if (s.step === 'tier') return { state: { ...s, step: 'effort', answers: { ...s.answers, tier: TIERS[choice] as TaskTier }, cursor: null } };
  if (s.step === 'effort') return { state: { ...s, step: 'plan', answers: { ...s.answers, effort: EFFORTS[choice] as TaskEffort }, cursor: null } };
  if (s.step === 'plan') return { state: { ...s, step: 'delegate', answers: { ...s.answers, plan: choice === 0 }, cursor: null } };
  // delegate: the last question, the card is complete
  const answers: Answers = { tier: s.answers.tier!, effort: s.answers.effort!, plan: s.answers.plan!, delegate: choice === 0 };
  return { state: { ...advance(s), saved: s.saved + 1 }, effect: { type: 'save', index: s.index, answers } };
}

// Options of the yes/no questions are ordered [yes, no].
export function reduce(s: SessionState, key: Key): { state: SessionState; effect?: Effect } {
  if (s.status !== 'running') return { state: s };
  if (key.k === 'ctrl-c') return { state: { ...s, status: 'quit' } };
  if (key.k === 'left' || key.k === 'right') {
    const n = optionCount(s.step);
    const cur = s.cursor === null ? (key.k === 'right' ? 0 : n - 1) : (s.cursor + (key.k === 'right' ? 1 : n - 1)) % n;
    return { state: { ...s, cursor: cur } };
  }
  if (key.k === 'enter') return s.cursor === null ? { state: s } : answer(s, s.cursor);
  if (key.k === 'backspace') return back(s);
  if (key.k !== 'char') return { state: s };

  const ch = normalizeChar(key.ch);
  if (ch === 'q') return { state: { ...s, status: 'quit' } };
  if (ch === 'b') return back(s);
  if (ch === 'g') return { state: { ...s, guesses: !s.guesses } };
  if (ch === 'e') return { state: { ...s, expanded: !s.expanded } };
  if (ch === 's') return { state: { ...advance(s), skipped: s.skipped + 1 } };
  if (ch === '?') return { state: { ...advance(s), saved: s.saved + 1 }, effect: { type: 'save', index: s.index, answers: 'unsure' } };
  if (s.step === 'plan' || s.step === 'delegate') {
    if (ch === 'y') return answer(s, 0);
    if (ch === 'n') return answer(s, 1);
    return { state: s };
  }
  const d = Number(ch);
  return Number.isInteger(d) && d >= 1 && d <= 3 ? answer(s, d - 1) : { state: s };
}

function back(s: SessionState): { state: SessionState } {
  const at = STEPS.indexOf(s.step);
  if (at > 0) {
    const prev = STEPS[at - 1]!;
    const answers = { ...s.answers };
    delete answers[({ effort: 'tier', plan: 'effort', delegate: 'plan' } as const)[s.step as 'effort']];
    return { state: { ...s, step: prev, answers, cursor: null } };
  }
  if (s.index === 0) return { state: s };
  // the previous card is asked again from the start; saving it again replaces the earlier verdict
  return { state: { ...s, index: s.index - 1, step: 'tier', answers: {}, cursor: null, expanded: false, guesses: false } };
}

// Runs a whole key sequence through the machine (tests, and the driver's chunk handling).
export function simulate(total: number, input: string | Key[]): { state: SessionState; effects: Effect[] } {
  let state = initialState(total);
  const effects: Effect[] = [];
  for (const key of typeof input === 'string' ? parseKeys(input) : input) {
    const r = reduce(state, key);
    state = r.state;
    if (r.effect) effects.push(r.effect);
  }
  return { state, effects };
}

// ───────── terminal driver ─────────

export interface KeyInput {
  setEncoding?(enc: 'utf8'): unknown;
  setRawMode?(raw: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(ev: 'data', fn: (chunk: string | Buffer) => void): unknown;
  off?(ev: 'data', fn: (chunk: string | Buffer) => void): unknown;
  removeListener?(ev: 'data', fn: (chunk: string | Buffer) => void): unknown;
}

export interface DriverOptions {
  input: KeyInput;
  output: { write(s: string): unknown; rows?: number };
  total: number;
  frame(s: SessionState, rows: number | undefined): string; // the card for the current state
  onSave(effect: Effect, seconds: number): void; // called before the next card is drawn
  now?: () => number;
}

const lineCount = (s: string): number => s.split('\n').length;

// Resolves when the session is done or quit. The raw mode is always restored.
export function runSession(o: DriverOptions): Promise<SessionState> {
  const now = o.now ?? Date.now;
  let state = initialState(o.total);
  let shownIndex = -1;
  let shownAt = now();
  let drawn = 0;
  const out = o.output;

  const draw = (): void => {
    if (state.status !== 'running') return;
    if (state.index !== shownIndex) {
      shownIndex = state.index;
      shownAt = now();
    }
    const f = o.frame(state, out.rows);
    out.write((drawn > 0 ? `\x1b[${drawn}F\x1b[J` : '') + f + '\n');
    drawn = lineCount(f);
  };

  return new Promise((resolve) => {
    const finish = (): void => {
      o.input.off?.('data', onData);
      o.input.removeListener?.('data', onData);
      o.input.setRawMode?.(false);
      o.input.pause?.();
      out.write('\x1b[?25h');
      if (drawn > 0) out.write(`\x1b[${drawn}F\x1b[J`); // the card goes away; the summary replaces it
      resolve(state);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const key of parseKeys(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
        const r = reduce(state, key);
        state = r.state;
        if (r.effect) o.onSave(r.effect, (now() - shownAt) / 1000);
        if (state.status !== 'running') return finish();
      }
      draw();
    };
    o.input.setEncoding?.('utf8');
    o.input.setRawMode?.(true);
    o.input.resume?.();
    o.input.on('data', onData);
    out.write('\x1b[?25l');
    if (state.status !== 'running') return finish();
    draw();
  });
}
