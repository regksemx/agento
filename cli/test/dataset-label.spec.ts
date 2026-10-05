import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { datasetLabelCmd, parseLabelFlags } from '../src/dataset/label/command.ts';
import { computeReport } from '../src/dataset/label/metrics.ts';
import { promptLines, renderCard, renderLabelReport, type CardView } from '../src/dataset/label/render.ts';
import { costEdges, disagreementScore, sampleTasks, stratumKey } from '../src/dataset/label/sample.ts';
import { initialState, parseKeys, reduce, runSession, simulate } from '../src/dataset/label/session.ts';
import { appendHumanRecord, humanMap, makeRecord, parseHumanLines, readHumanFile, readHumanLabels, readL1Guesses, toCsv } from '../src/dataset/label/store.ts';
import type { HumanRecord, L1Guess } from '../src/dataset/label/types.ts';
import { visWidth } from '../src/report/format.ts';
import type { TaskRecord } from '../src/dataset/types.ts';

// A synthetic task: nothing here comes from a real history.
function task(id: string, p: Partial<TaskRecord> = {}, o: Partial<TaskRecord['observed']> = {}): TaskRecord {
  return {
    v: 1,
    taskId: id,
    project: '~/Projects/acme-shop',
    startTs: new Date(2026, 8, 12, 14, 3).getTime(), // local time, so the card does not depend on the time zone
    text: ['Add pagination to the orders list in the admin panel.'],
    context: { contextTokensAtStart: 40_000, startKind: 'first-prompt', languages: ['ts'], hasGitBranch: true, prevTaskWasHeavy: false },
    observed: {
      model: 'claude-opus-5-5',
      modelTier: 'opus',
      effort: 'high',
      mainCalls: 17,
      subagentCalls: 3,
      subagentTypes: ['Explore'],
      filesEdited: 4,
      linesChanged: 123,
      toolErrors: 2,
      testRuns: 5,
      testFailures: 1,
      sameEditRepeats: 0,
      userCorrections: 1,
      userInterrupts: 0,
      planMode: false,
      durationMs: 12 * 60_000,
      outputTokens: 20_000,
      cost: 3.45,
      ...o,
    },
    difficulty: 0.5,
    l0Tier: 'sonnet',
    l0Effort: 'high',
    rulesVerdict: { tier: 'opus', effort: 'high', confidence: 0.5, reasons: [] },
    labelSource: 'L0',
    ...p,
  };
}

const LONG = Array.from({ length: 20 }, (_, i) => `Requirement ${i + 1}: keep the sort order across pages.`).join('\n');

const opts = { color: 'none', width: 80, lang: 'ru' } as const;
const view = (t: TaskRecord, p: Partial<CardView> = {}): CardView => ({ task: t, index: 2, total: 50, saved: 12, step: 'tier', answers: {}, cursor: null, expanded: false, guesses: false, ...p });

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agento-label-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sampling', () => {
  const pool: TaskRecord[] = [];
  for (const model of ['haiku', 'sonnet', 'opus'] as const)
    for (const l0 of ['haiku', 'sonnet', 'opus'] as const)
      for (let k = 0; k < 6; k++) pool.push(task(`${model}-${l0}-${k}`, { l0Tier: l0 }, { modelTier: model, cost: k * 2 }));

  it('skips labeled tasks, caps n and is deterministic', () => {
    const labeled = new Set(pool.slice(0, 20).map((t) => t.taskId));
    const a = sampleTasks(pool, { n: 15, strategy: 'random', seed: 7, labeled });
    const b = sampleTasks([...pool].reverse(), { n: 15, strategy: 'random', seed: 7, labeled });
    expect(a).toHaveLength(15);
    expect(a.map((t) => t.taskId)).toEqual(b.map((t) => t.taskId));
    expect(a.every((t) => !labeled.has(t.taskId))).toBe(true);
    expect(sampleTasks(pool, { n: 15, strategy: 'random', seed: 8, labeled }).map((t) => t.taskId)).not.toEqual(a.map((t) => t.taskId));
    expect(sampleTasks(pool, { n: 999, strategy: 'random', seed: 1, labeled })).toHaveLength(pool.length - 20);
  });

  it('stratified covers model x l0 tier x cost quartile cells before repeating one', () => {
    const edges = costEdges(pool);
    const cells = new Set(pool.map((t) => stratumKey(t, edges)));
    expect(cells.size).toBeGreaterThan(9);
    const s = sampleTasks(pool, { n: cells.size, strategy: 'stratified', seed: 3, labeled: new Set() });
    expect(new Set(s.map((t) => stratumKey(t, edges))).size).toBe(cells.size);
    const again = sampleTasks(pool, { n: 12, strategy: 'stratified', seed: 3, labeled: new Set() });
    expect(again.map((t) => t.taskId)).toEqual(sampleTasks(pool, { n: 12, strategy: 'stratified', seed: 3, labeled: new Set() }).map((t) => t.taskId));
  });

  it('stratified balances the observed models even when one dominates', () => {
    const skew = [...Array.from({ length: 40 }, (_, i) => task(`o${i}`, {}, { modelTier: 'opus', cost: 1 })), ...Array.from({ length: 4 }, (_, i) => task(`s${i}`, {}, { modelTier: 'sonnet', cost: 1 }))];
    const s = sampleTasks(skew, { n: 6, strategy: 'stratified', seed: 1, labeled: new Set() });
    expect(s.filter((t) => t.observed.modelTier === 'sonnet').length).toBeGreaterThanOrEqual(1);
  });

  it('disagreement prefers contested tasks; the L1 judge counts when present', () => {
    const calm = task('calm', { l0Tier: 'sonnet', rulesVerdict: { tier: 'sonnet', effort: 'high', confidence: 1, reasons: [] } });
    const split = task('split', { l0Tier: 'haiku', rulesVerdict: { tier: 'opus', effort: 'high', confidence: 1, reasons: [] } });
    const l1Only = task('l1only', { l0Tier: 'sonnet', rulesVerdict: { tier: 'sonnet', effort: 'high', confidence: 1, reasons: [] } });
    const l1 = new Map<string, L1Guess>([['l1only', { tier: 'opus', effort: 'high' }]]);
    expect(disagreementScore(calm)).toBe(0);
    expect(disagreementScore(split)).toBeGreaterThanOrEqual(2);
    expect(disagreementScore(l1Only, l1.get('l1only'))).toBe(2);
    const many = [calm, ...Array.from({ length: 5 }, (_, i) => ({ ...calm, taskId: `c${i}` })), split, l1Only];
    const top = sampleTasks(many, { n: 2, strategy: 'disagreement', seed: 1, labeled: new Set(), l1 });
    expect(top.map((t) => t.taskId).sort()).toEqual(['l1only', 'split']);
    // without a judge file the L1-only disagreement is invisible
    const noJudge = sampleTasks(many, { n: 1, strategy: 'disagreement', seed: 1, labeled: new Set() });
    expect(noJudge[0]!.taskId).toBe('split');
  });
});

describe('card rendering', () => {
  it('ru card snapshot (no color, width 80)', () => {
    expect(renderCard(view(task('a')), opts)).toMatchSnapshot();
  });
  it('en card with guesses revealed and a highlighted option', () => {
    const t = task('a', {}, { effort: undefined, planMode: true });
    expect(renderCard(view(t, { guesses: true, l1: { tier: 'haiku', effort: 'low' }, step: 'effort', answers: { tier: 'sonnet' }, cursor: 1 }), { ...opts, lang: 'en' })).toMatchSnapshot();
  });

  it('never exceeds the width, in every step, language and width', () => {
    for (const width of [64, 80, 100]) {
      for (const lang of ['ru', 'en'] as const) {
        for (const step of ['tier', 'effort', 'plan', 'delegate'] as const) {
          const t = task('a', { text: [LONG] });
          for (const line of renderCard(view(t, { step, guesses: true, l1: { tier: 'opus', effort: 'medium' }, answers: { tier: 'opus', effort: 'high', plan: true } }), { color: 'none', width, lang }).split('\n')) {
            expect(visWidth(line)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it('shows at most 12 prompt lines, counts the rest and expands on request', () => {
    const t = task('a', { text: [LONG] });
    const lines = promptLines(LONG, 70);
    expect(lines.length).toBe(20);
    const folded = renderCard(view(t), opts).split('\n');
    expect(folded.filter((l) => l.startsWith('  │ Requirement')).length).toBe(12);
    expect(folded.join('\n')).toContain('…ещё 8 строк (e — развернуть)');
    const open = renderCard(view(t, { expanded: true }), opts);
    expect(open).toContain('Requirement 20');
    expect(open).not.toContain('…ещё');
    expect(renderCard(view(t), { ...opts, lang: 'en' })).toContain('…8 more lines (e — expand)');
    expect(renderCard(view(task('b', { text: ['x\n'.repeat(13)] })), opts)).toContain('…ещё 1 строка');
  });

  it('hides the guesses until revealed and never mixes them into the facts', () => {
    const hidden = renderCard(view(task('a')), opts);
    expect(hidden).toContain('догадки скрыты');
    expect(hidden).not.toContain('L0 ');
    const shown = renderCard(view(task('a'), { guesses: true }), opts);
    expect(shown).toContain('L0 sonnet·high · правила opus·high · L1 —');
  });

  it('keeps colors out of no-color mode and uses them otherwise', () => {
    expect(renderCard(view(task('a')), opts)).not.toContain('\x1b[');
    expect(renderCard(view(task('a')), { ...opts, color: 'truecolor' })).toContain('\x1b[');
  });

  it('strips control characters from the prompt', () => {
    const t = task('a', { text: ['hello \x1b[31mred\x1b[0m\x07 world'] });
    expect(renderCard(view(t), opts)).not.toContain('\x1b');
  });
});

describe('keypress state machine', () => {
  it('parses plain keys, arrows, Enter, Backspace, Ctrl+C and unknown escapes', () => {
    expect(parseKeys('1y\x1b[C\x1b[D\r\x7f\x03\x1b[3~')).toEqual([
      { k: 'char', ch: '1' },
      { k: 'char', ch: 'y' },
      { k: 'right' },
      { k: 'left' },
      { k: 'enter' },
      { k: 'backspace' },
      { k: 'ctrl-c' },
    ]);
    expect(parseKeys('\x1bOC')).toEqual([{ k: 'right' }]);
  });

  it('answers four questions and saves one verdict', () => {
    const { state, effects } = simulate(3, '3' + '2' + 'y' + 'n');
    expect(effects).toEqual([{ type: 'save', index: 0, answers: { tier: 'opus', effort: 'medium', plan: true, delegate: false } }]);
    expect(state).toMatchObject({ index: 1, step: 'tier', saved: 1, status: 'running' });
  });

  it('accepts arrows and Enter, and a Russian layout for the letter keys', () => {
    const { effects } = simulate(1, '\x1b[C\x1b[C\r' /* sonnet */ + '\x1b[D\r' /* effort: wraps to high */ + 'н' /* y */ + 'т' /* n */);
    expect(effects[0]).toEqual({ type: 'save', index: 0, answers: { tier: 'sonnet', effort: 'high', plan: true, delegate: false } });
    expect(simulate(2, 'ы').state).toMatchObject({ index: 1, skipped: 1 });
    expect(simulate(2, 'й').state.status).toBe('quit');
  });

  it('Enter without a highlight does nothing; irrelevant digits are ignored in yes/no questions', () => {
    expect(simulate(1, '\r').state).toMatchObject({ step: 'tier', saved: 0 });
    expect(simulate(1, '12' + '3').state.step).toBe('plan');
  });

  it('skip moves on without saving; ? saves "unsure"', () => {
    const r = simulate(3, 's' + '?' + '1');
    expect(r.effects).toEqual([{ type: 'save', index: 1, answers: 'unsure' }]);
    expect(r.state).toMatchObject({ index: 2, step: 'effort', answers: { tier: 'haiku' }, saved: 1, skipped: 1 });
    expect(simulate(1, '2?').effects).toEqual([{ type: 'save', index: 0, answers: 'unsure' }]);
  });

  it('b goes back a question, then back a card; the earlier answer is replaced', () => {
    let r = simulate(3, '3' + '2' + 'b');
    expect(r.state).toMatchObject({ index: 0, step: 'effort', answers: { tier: 'opus' } });
    r = simulate(3, '3' + '2' + 'b' + 'b');
    expect(r.state).toMatchObject({ step: 'tier', answers: {} });
    r = simulate(3, '123yn' + 'b' + '3' + '3' + 'yy');
    expect(r.state).toMatchObject({ index: 1, step: 'tier' });
    expect(r.effects.map((e) => e.index)).toEqual([0, 0]); // the card 0 is saved twice: the second one wins in the store
    expect(r.effects[1]).toEqual({ type: 'save', index: 0, answers: { tier: 'opus', effort: 'high', plan: true, delegate: true } });
    expect(simulate(3, 'b').state).toMatchObject({ index: 0, step: 'tier' }); // nothing before the first card
    expect(simulate(2, '\x7f').state.index).toBe(0);
  });

  it('q and Ctrl+C stop; later keys are ignored; answers before the stop were already emitted', () => {
    for (const stop of ['q', '\x03']) {
      const r = simulate(5, '123yn' + stop + '123yn');
      expect(r.state.status).toBe('quit');
      expect(r.effects).toHaveLength(1);
    }
  });

  it('g and e toggle per card and reset on the next card', () => {
    let s = initialState(2);
    s = reduce(s, { k: 'char', ch: 'g' }).state;
    s = reduce(s, { k: 'char', ch: 'e' }).state;
    expect(s).toMatchObject({ guesses: true, expanded: true });
    s = simulate(2, '').state;
    expect(simulate(2, 'ge' + '123yn').state).toMatchObject({ guesses: false, expanded: false, index: 1 });
  });

  it('finishes after the last card, and an empty queue is done at once', () => {
    expect(simulate(1, '123yn').state.status).toBe('done');
    expect(simulate(1, 's').state.status).toBe('done');
    expect(initialState(0).status).toBe('done');
  });
});

describe('terminal driver', () => {
  class FakeInput extends EventEmitter {
    raw = false;
    paused = true;
    setEncoding(): void {}
    setRawMode(r: boolean): void {
      this.raw = r;
    }
    resume(): void {
      this.paused = false;
    }
    pause(): void {
      this.paused = true;
    }
  }

  it('enters raw mode, saves each verdict before the next card, restores the terminal', async () => {
    const input = new FakeInput();
    const writes: string[] = [];
    const saved: Array<{ index: number; seconds: number }> = [];
    let clock = 1000;
    const p = runSession({
      input,
      output: { write: (s) => void writes.push(s) },
      total: 2,
      now: () => (clock += 5000),
      frame: (s) => `card ${s.index} ${s.step}`,
      onSave: (e, seconds) => void saved.push({ index: e.index, seconds }),
    });
    expect(input.raw).toBe(true);
    input.emit('data', '12y');
    input.emit('data', 'n3');
    input.emit('data', '\x03');
    const final = await p;
    expect(final.status).toBe('quit');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.index).toBe(0);
    expect(saved[0]!.seconds).toBeGreaterThan(0);
    expect(input.raw).toBe(false);
    expect(input.paused).toBe(true);
    expect(input.listenerCount('data')).toBe(0);
    expect(writes.join('')).toContain('\x1b[?25l');
    expect(writes.join('')).toContain('\x1b[?25h');
  });
});

describe('store', () => {
  const answers = { tier: 'haiku', effort: 'low', plan: false, delegate: true } as const;

  it('writes the gold fields the training export reads', () => {
    const r = makeRecord('t1', answers, 12.4, Date.UTC(2026, 9, 5, 10));
    expect(r).toMatchObject({ taskId: 't1', ok: true, labelSource: 'human', labeledAt: '2026-10-05T10:00:00.000Z', labelerSeconds: 12, unsure: false, l2Tier: 'haiku', l2Effort: 'low', l2PlanFirst: false, l2DelegateExplore: true });
    expect(makeRecord('t1', 'unsure', 5000, 0)).toMatchObject({ unsure: true, l2Tier: null, l2Effort: null, l2PlanFirst: null, l2DelegateExplore: null, labelerSeconds: 3600 });
  });

  it('appends one line per record; re-labeling replaces (last wins); a torn line is closed and ignored', () => {
    const f = join(tmp(), 'judge', 'human.jsonl');
    appendHumanRecord(f, makeRecord('t1', answers, 3, 1));
    appendHumanRecord(f, makeRecord('t2', 'unsure', 3, 2));
    appendHumanRecord(f, makeRecord('t1', { tier: 'opus', effort: 'high', plan: true, delegate: false }, 3, 3));
    appendFileSync(f, '{"taskId":"torn","ok":tr'); // a crash mid-write
    appendHumanRecord(f, makeRecord('t3', answers, 3, 4));
    const text = readFileSync(f, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(5);
    expect(text.endsWith('\n')).toBe(true);
    const all = readHumanFile(f);
    expect(all.map((r) => r.taskId)).toEqual(['t1', 't2', 't1', 't3']);
    const m = readHumanLabels(f);
    expect([...m.keys()]).toEqual(['t1', 't2', 't3']);
    expect(m.get('t1')!.l2Tier).toBe('opus');
    expect(m.get('t2')!.unsure).toBe(true);
  });

  it('ignores lines that are not human records', () => {
    expect(parseHumanLines('{"taskId":"a","ok":false}\nnot json\n{"taskId":"b","ok":true}\n')).toHaveLength(1);
    expect(humanMap([]).size).toBe(0);
  });

  it('reads L1 guesses and writes CSV without prompt text', () => {
    const f = join(tmp(), 'j.jsonl');
    writeFileSync(f, JSON.stringify({ taskId: 'a', ok: true, l1Tier: 'haiku', l1Effort: 'low', needsPlanFirst: true, delegateExplore: false }) + '\n' + JSON.stringify({ taskId: 'b', ok: false }) + '\n');
    expect(readL1Guesses(f).get('a')).toEqual({ tier: 'haiku', effort: 'low', planFirst: true, delegateExplore: false });
    expect(readL1Guesses(join(tmp(), 'none.jsonl')).size).toBe(0);
    expect(toCsv([['a', 'p, "q"', null]]).split('\n')[1]).toBe('a,"p, ""q""",');
  });
});

describe('agreement metrics', () => {
  const h = (id: string, tier: HumanRecord['l2Tier'], effort: HumanRecord['l2Effort'], plan = false, del = false): [string, HumanRecord] => [id, makeRecord(id, tier ? { tier, effort: effort!, plan, delegate: del } : 'unsure', 10, 0)];

  it('counts accuracy, under- and over-routing per source, and skips what cannot be compared', () => {
    const tasks = [
      task('a', { l0Tier: 'haiku', l0Effort: 'low' }, { modelTier: 'opus', effort: 'xhigh' }),
      task('b', { l0Tier: 'opus', l0Effort: 'high' }, { modelTier: 'fable', effort: undefined }),
      task('c', { l0Tier: 'sonnet', l0Effort: 'medium' }, { modelTier: 'unknown' }),
      task('d'),
    ];
    const human = new Map([h('a', 'sonnet', 'medium', true, false), h('b', 'sonnet', 'high'), h('c', 'sonnet', 'medium'), h('d', null, null), h('gone', 'opus', 'high')]);
    const l1 = new Map<string, L1Guess>([
      ['a', { tier: 'haiku', effort: 'low', planFirst: false, delegateExplore: false }],
      ['b', { tier: 'sonnet', effort: 'high' }],
    ]);
    const r = computeReport(tasks, human, l1);
    expect(r).toMatchObject({ tasksTotal: 4, labeled: 3, unsure: 1, tier: { haiku: 0, sonnet: 3, opus: 0 }, planYes: 1 });
    const s = Object.fromEntries(r.sources.map((x) => [x.id, x]));
    expect(s.l0).toMatchObject({ n: 3, tierHit: 1, under: 1, over: 1, effortN: 3, effortHit: 2 });
    expect(s.l1).toMatchObject({ n: 2, tierHit: 1, under: 1, over: 0, effortN: 2, effortHit: 1 });
    expect(s.history).toMatchObject({ n: 2, tierHit: 0, under: 0, over: 2, effortN: 1, effortHit: 0 }); // fable counts as opus, unknown has no tier
    expect(s.rules!.n).toBe(3);
    expect(r.l1Flags).toEqual({ planN: 1, planHit: 0, delegateN: 1, delegateHit: 1 });
    expect(s.l0!.confusion.sonnet).toEqual({ haiku: 1, sonnet: 1, opus: 1 });
  });

  it('renders the report in both languages without color and within the width', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task(`t${i}`, { l0Tier: i % 2 ? 'opus' : 'haiku' }));
    const human = new Map(tasks.map((t, i) => h(t.taskId, i % 3 === 0 ? 'haiku' : 'sonnet', 'medium', i === 1, i === 2)));
    const l1 = new Map<string, L1Guess>(tasks.map((t) => [t.taskId, { tier: 'opus', effort: 'high' } as L1Guess]));
    const rep = computeReport(tasks, human, l1);
    for (const lang of ['ru', 'en'] as const) {
      const out = renderLabelReport(rep, { generatedAt: '2026-10-05T10:00:00.000Z', path: '/x/human.jsonl' }, { color: 'none', width: 80, lang });
      expect(out).not.toContain('\x1b[');
      for (const l of out.split('\n')) expect(visWidth(l)).toBeLessThanOrEqual(80);
      expect(out).toContain('L1');
    }
    const empty = renderLabelReport(computeReport(tasks, new Map(), new Map()), { generatedAt: '2026-10-05T10:00:00.000Z', path: '/x' }, opts);
    expect(empty).toContain('Размеченных задач пока нет');
  });
});

describe('command', () => {
  function setup(n = 4): { home: string; env: Record<string, string>; flags: (o?: Record<string, string | true>) => Map<string, string | true> } {
    const home = tmp();
    const dir = join(home, 'dataset');
    mkdirSync(dir, { recursive: true });
    const tasks = Array.from({ length: n }, (_, i) => task(`task${i}`, { text: [`Synthetic prompt number ${i}`] }));
    writeFileSync(join(dir, 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
    return { home, env: { AGENTO_HOME: home }, flags: (o = {}) => new Map<string, string | true>([['no-color', true], ...Object.entries(o)]) };
  }
  const sink = (): { write(s: string): void; text: () => string; columns: number; isTTY: boolean } => {
    const parts: string[] = [];
    return { write: (s: string) => void parts.push(s), text: () => parts.join(''), columns: 80, isTTY: true };
  };

  it('parses flags and rejects bad values', () => {
    const o = parseLabelFlags(new Map<string, string | true>([['n', '10'], ['strategy', 'disagreement'], ['export-csv', true]]), { AGENTO_HOME: '/h' });
    expect(o).toMatchObject({ n: 10, strategy: 'disagreement', seed: 1, exportCsv: true, outPath: '/h/dataset/judge/human.jsonl', tasksPath: '/h/dataset/tasks.jsonl' });
    expect(parseLabelFlags(new Map(), { AGENTO_HOME: '/h' })).toMatchObject({ n: 50, strategy: 'stratified', report: false });
    expect(() => parseLabelFlags(new Map([['n', '0']]))).toThrow(/--n/);
    expect(() => parseLabelFlags(new Map([['strategy', 'x']]))).toThrow(/--strategy/);
  });

  it('refuses without a terminal, but --report and --export-csv still work', async () => {
    const { env, flags } = setup();
    const out = sink();
    const err = sink();
    const noTty = { isTTY: false, on() {} } as never;
    expect(await datasetLabelCmd(flags(), 'en', { env, stdin: noTty, stdout: out, stderr: err })).toBe(1);
    expect(err.text()).toContain('interactive terminal');
    expect(await datasetLabelCmd(flags({ report: true }), 'en', { env, stdin: noTty, stdout: out, stderr: err })).toBe(0);
    expect(out.text()).toContain('No labeled tasks yet');
    const csvOut = sink();
    expect(await datasetLabelCmd(flags({ 'export-csv': true }), 'en', { env, stdin: noTty, stdout: csvOut, stderr: err })).toBe(0);
    expect(csvOut.text().split('\n')[0]).toMatch(/^taskId,project,date,humanTier/);
  });

  it('runs a session: saves each verdict, skips labeled tasks next time, and prints the agreement', async () => {
    const { home, env, flags } = setup(4);
    const input = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode(): void; resume(): void; pause(): void; setEncoding(): void };
    Object.assign(input, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    const out = sink();
    const p = datasetLabelCmd(flags({ n: '3', strategy: 'random' }), 'ru', { env, stdin: input as never, stdout: out, stderr: sink() });
    // card 1: sonnet, medium, plan yes, explore no. card 2: skipped. card 3: unsure. Then quit is not needed: queue is over.
    input.emit('data', '22yn');
    input.emit('data', 's');
    input.emit('data', '?');
    expect(await p).toBe(0);
    const file = join(home, 'dataset', 'judge', 'human.jsonl');
    const recs = readHumanFile(file);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ ok: true, labelSource: 'human', l2Tier: 'sonnet', l2Effort: 'medium', l2PlanFirst: true, l2DelegateExplore: false, unsure: false });
    expect(recs[1]).toMatchObject({ unsure: true, l2Tier: null });
    expect(out.text()).toContain('ваши метки');
    expect(out.text()).toContain('записано в этой сессии: 2');

    // the next session never shows the two labeled tasks again
    const shown = new Set<string>();
    const input2 = new EventEmitter() as typeof input;
    Object.assign(input2, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    const out2 = sink();
    const p2 = datasetLabelCmd(flags({ n: '10', strategy: 'random' }), 'en', { env, stdin: input2 as never, stdout: out2, stderr: sink() });
    for (const t of readTasksIds(home)) if (out2.text().includes(`number ${t.n}`)) shown.add(t.id);
    input2.emit('data', 'q');
    await p2;
    const labeled = new Set(recs.map((r) => r.taskId));
    for (const id of shown) expect(labeled.has(id)).toBe(false);
    expect(shown.size).toBeGreaterThan(0);
  });

  it('Ctrl+C keeps what was answered', async () => {
    const { home, env, flags } = setup(3);
    const input = new EventEmitter() as EventEmitter & { isTTY: boolean };
    Object.assign(input, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    const p = datasetLabelCmd(flags({ n: '3' }), 'en', { env, stdin: input as never, stdout: sink(), stderr: sink() });
    input.emit('data', '1' + '1' + 'n' + 'n');
    input.emit('data', '3');
    input.emit('data', '\x03');
    await p;
    expect(readHumanFile(join(home, 'dataset', 'judge', 'human.jsonl'))).toHaveLength(1);
    expect(existsSync(join(home, 'dataset', 'judge', 'human.jsonl'))).toBe(true);
  });
});

function readTasksIds(home: string): Array<{ id: string; n: number }> {
  return readFileSync(join(home, 'dataset', 'tasks.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l, n) => ({ id: (JSON.parse(l) as TaskRecord).taskId, n }));
}
