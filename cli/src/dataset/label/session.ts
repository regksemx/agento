// The labeling session: a pure keypress state machine (`reduce`), a key parser for raw-mode input (`parseKeys`) and the
// terminal driver (`runSession`). Single keypress per question, no Enter needed; arrows move a highlight, Enter confirms it.

import type { TaskEffort, TaskTier } from '../../../../plugin/core/task.ts';
import type { Answers } from './store.ts';
import { EFFORTS, TIERS } from './types.ts';

export type Step = 'tier' | 'effort' | 'plan' | 'delegate';
export const STEPS: readonly Step[] = ['tier', 'effort', 'plan', 'delegate'];

export type Key =
  | { k: 'char'; ch: string }
  | { k: 'left' | 'right' | 'up' | 'down' | 'pgup' | 'pgdn' | 'enter' | 'backspace' | 'esc' | 'ctrl-c' };

export interface SessionState {
  index: number; // current card
  total: number;
  step: Step;
  answers: Partial<Answers>;
  cursor: number | null; // arrow highlight in the current question
  expanded: boolean; // full-screen reader of the prompt
  scroll: number; // first prompt line shown in the reader
  guesses: boolean; // L0/rules/L1 guesses revealed
  status: 'running' | 'done' | 'quit';
  saved: number; // verdicts written in this session (full or "don't remember")
  skipped: number;
}

export type Effect = { type: 'save'; index: number; answers: Answers | 'unsure' };

export function initialState(total: number): SessionState {
  return { index: 0, total, step: 'tier', answers: {}, cursor: null, expanded: false, scroll: 0, guesses: false, status: total > 0 ? 'running' : 'done', saved: 0, skipped: 0 };
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
        const name = m[2] === '~'
          ? ({ '5': 'pgup', '6': 'pgdn' } as const)[m[1] as '5']
          : ({ A: 'up', B: 'down', C: 'right', D: 'left' } as const)[m[2] as 'A'];
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
  return { ...s, index, step: 'tier', answers: {}, cursor: null, expanded: false, scroll: 0, guesses: false, status: index >= s.total ? 'done' : 'running' };
}

function answer(s: SessionState, choice: number): { state: SessionState; effect?: Effect } {
  if (s.step === 'tier') return { state: { ...s, step: 'effort', answers: { ...s.answers, tier: TIERS[choice] as TaskTier }, cursor: null } };
  if (s.step === 'effort') return { state: { ...s, step: 'plan', answers: { ...s.answers, effort: EFFORTS[choice] as TaskEffort }, cursor: null } };
  if (s.step === 'plan') return { state: { ...s, step: 'delegate', answers: { ...s.answers, plan: choice === 0 }, cursor: null } };
  // delegate: the last question, the card is complete
  const answers: Answers = { tier: s.answers.tier!, effort: s.answers.effort!, plan: s.answers.plan!, delegate: choice === 0 };
  return { state: { ...advance(s), saved: s.saved + 1 }, effect: { type: 'save', index: s.index, answers } };
}

// Lines scrolled by PgUp/PgDn/Space in the reader.
export const PAGE = 10;

// Options of the yes/no questions are ordered [yes, no].
export function reduce(s: SessionState, key: Key): { state: SessionState; effect?: Effect } {
  if (s.status !== 'running') return { state: s };
  if (key.k === 'ctrl-c') return { state: { ...s, status: 'quit' } };
  if (s.expanded && (key.k === 'up' || key.k === 'down' || key.k === 'pgup' || key.k === 'pgdn')) {
    const delta = { up: -1, down: 1, pgup: -PAGE, pgdn: PAGE }[key.k];
    return { state: { ...s, scroll: Math.max(0, s.scroll + delta) } };
  }
  if (key.k === 'esc') return s.expanded ? { state: { ...s, expanded: false, scroll: 0 } } : { state: s };
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
  if (ch === 'e') return { state: { ...s, expanded: !s.expanded, scroll: 0 } };
  if (ch === ' ' && s.expanded) return { state: { ...s, scroll: s.scroll + PAGE } };
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
  return { state: { ...s, index: s.index - 1, step: 'tier', answers: {}, cursor: null, expanded: false, scroll: 0, guesses: false } };
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
  output: { write(s: string): unknown; rows?: number; on?(ev: 'resize', fn: () => void): unknown; off?(ev: 'resize', fn: () => void): unknown };
  total: number;
  frame(s: SessionState, rows: number | undefined): string; // the card for the current state
  clamp?(s: SessionState, rows: number | undefined): SessionState; // keeps the reader scroll within the prompt
  onSave(effect: Effect, seconds: number): void; // called before the next card is drawn
  now?: () => number;
}

// The card is drawn on the alternate screen and repainted whole, so wrapped or overlong cards never leave debris.
const ENTER_ALT = '\x1b[?1049h\x1b[?25l';
const LEAVE_ALT = '\x1b[?25h\x1b[?1049l';

// Resolves when the session is done or quit. The raw mode is always restored.
export function runSession(o: DriverOptions): Promise<SessionState> {
  const now = o.now ?? Date.now;
  let state = initialState(o.total);
  let shownIndex = -1;
  let shownAt = now();
  const out = o.output;

  const draw = (): void => {
    if (state.status !== 'running') return;
    if (state.index !== shownIndex) {
      shownIndex = state.index;
      shownAt = now();
    }
    if (o.clamp) state = o.clamp(state, out.rows);
    let lines = o.frame(state, out.rows).split('\n');
    if (out.rows && lines.length > out.rows) lines = lines.slice(0, out.rows);
    out.write('\x1b[H\x1b[2J' + lines.join('\n'));
  };
  const onResize = (): void => draw();

  return new Promise((resolve) => {
    const finish = (): void => {
      o.input.off?.('data', onData);
      o.input.removeListener?.('data', onData);
      o.input.setRawMode?.(false);
      o.input.pause?.();
      out.off?.('resize', onResize);
      out.write(LEAVE_ALT); // the card goes away with the alternate screen; the summary is printed after
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
    out.on?.('resize', onResize);
    out.write(ENTER_ALT);
    if (state.status !== 'running') return finish();
    draw();
  });
}
