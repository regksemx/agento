import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bar, localStamp, money, pct, sanitizeInline, stripAnsi, tildify, truncate, visWidth, wrap } from '../src/report/format.ts';
import { detectColor, renderJson, renderMarkdown, renderTerminal } from '../src/report/index.ts';
import type { AuditReport } from '../src/types.ts';
import { makeSampleReport, sampleReport, sampleReportEn } from './sample-report.ts';

// The header shows local time: pin a zone that is neither UTC nor the CI default, so snapshots are stable.
process.env.TZ = 'Europe/Moscow';

const lines = (s: string): string[] => s.split('\n');
// Wrapped notes joined back into one line, so that a phrase can be asserted whole.
const flat = (s: string): string => s.replace(/\n\s*(⎿ )?/g, ' ');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('format helpers', () => {
  it('strips ANSI sequences', () => {
    expect(stripAnsi('\x1b[1;38;2;217;119;87mHi\x1b[0m \x1b[38;5;173mthere\x1b[0m')).toBe('Hi there');
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('measures visible width, treating CJK as wide and ignoring ANSI', () => {
    expect(visWidth('\x1b[31mabc\x1b[0m')).toBe(3);
    expect(visWidth('日本語')).toBe(6);
    expect(visWidth('Привет')).toBe(6);
  });

  it('formats money and percentages', () => {
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(0.42)).toBe('$0.42');
    expect(money(-3)).toBe('−$3.00');
    expect(pct(0.813)).toBe('81%');
    expect(pct(0.001)).toBe('<1%');
    expect(pct(0)).toBe('0%');
  });

  it('shows ISO timestamps as local time', () => {
    expect(localStamp('2026-10-05T14:02:11.000Z')).toBe('2026-10-05 17:02'); // Europe/Moscow, UTC+3
    expect(localStamp('2026-10-05T22:30:00.000Z')).toBe('2026-10-06 01:30'); // crosses midnight
    expect(localStamp('garbage')).toBe('garbage');
  });

  it('replaces the home directory with ~', () => {
    expect(tildify('/Users/me/Projects/x', '/Users/me')).toBe('~/Projects/x');
    expect(tildify('/Users/me', '/Users/me/')).toBe('~');
    expect(tildify('/Users/me2/x', '/Users/me')).toBe('/Users/me2/x');
    expect(tildify('/opt/x', '/Users/me')).toBe('/opt/x');
    expect(tildify('~/x', '/Users/me')).toBe('~/x');
    expect(tildify('/x', '')).toBe('/x');
  });

  it('draws smooth bars within the width', () => {
    expect(bar(1, 10)).toBe('█'.repeat(10));
    expect(bar(0.5, 10)).toBe('█████');
    expect(bar(0.55, 10)).toBe('█████▌');
    expect(bar(0.001, 10)).toBe('▏');
    expect(bar(0, 10)).toBe('');
  });

  it('truncates and wraps by visible width', () => {
    expect(truncate('abcdefghij', 6)).toBe('abcde…');
    expect(visWidth(truncate('日本語日本語', 7))).toBeLessThanOrEqual(7);
    for (const l of wrap('one two three four five six seven eight nine ten', 12)) expect(l.length).toBeLessThanOrEqual(12);
    expect(sanitizeInline('a\n\tb 😀 c')).toBe('a b c');
  });
});

describe('detectColor', () => {
  it('honours NO_COLOR, TTY and COLORTERM', () => {
    expect(detectColor({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe('none');
    expect(detectColor({ COLORTERM: 'truecolor' }, false)).toBe('none');
    expect(detectColor({ COLORTERM: 'truecolor' }, true)).toBe('truecolor');
    expect(detectColor({ COLORTERM: '24bit' }, true)).toBe('truecolor');
    expect(detectColor({ TERM: 'xterm-256color' }, true)).toBe('256');
    expect(detectColor({ TERM: 'dumb' }, true)).toBe('none');
    expect(detectColor({ FORCE_COLOR: '3' }, false)).toBe('truecolor');
    expect(detectColor({ FORCE_COLOR: '0' }, true)).toBe('none');
  });
});

describe('renderTerminal', () => {
  for (const [name, report] of [['ru', sampleReport], ['en', sampleReportEn]] as const) {
    for (const width of [64, 100]) {
      it(`snapshot ${name} none ${width}`, () => {
        expect(renderTerminal(report, { color: 'none', width })).toMatchSnapshot();
      });
    }
  }

  it('draws the actions box with every border line the same width', () => {
    for (const width of [64, 80, 100]) {
      const lines = renderTerminal(sampleReport, { color: 'none', width }).split('\n').filter((l) => /[╭│╰]/.test(l));
      expect(new Set(lines.map((l) => visWidth(l))).size).toBe(1);
    }
  });

  it('never exceeds the width and emits no escapes without color', () => {
    for (const report of [sampleReport, sampleReportEn]) {
      for (const width of [64, 72, 80, 90, 100]) {
        const text = renderTerminal(report, { color: 'none', width });
        expect(text).not.toContain('\x1b');
        for (const l of lines(text)) expect(visWidth(l), `${width}: ${l}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('keeps colored output within the width too, and clamps absurd widths', () => {
    for (const mode of ['truecolor', '256'] as const) {
      const text = renderTerminal(sampleReport, { color: mode, width: 64 });
      for (const l of lines(text)) expect(visWidth(l)).toBeLessThanOrEqual(64);
      expect(lines(renderTerminal(sampleReport, { color: 'none', width: 20 })).every((l) => visWidth(l) <= 64)).toBe(true);
      expect(lines(renderTerminal(sampleReport, { color: 'none', width: 500 })).every((l) => visWidth(l) <= 100)).toBe(true);
    }
  });

  it('uses the clay accent in truecolor and 173 in 256 mode, same text as plain', () => {
    const tc = renderTerminal(sampleReport, { color: 'truecolor', width: 90 });
    const c256 = renderTerminal(sampleReport, { color: '256', width: 90 });
    const plain = renderTerminal(sampleReport, { color: 'none', width: 90 });
    expect(tc).toContain('38;2;217;119;87');
    expect(c256).toContain('38;5;173');
    expect(c256).not.toContain('38;2;');
    // only the stacked bucket bar differs: solid blocks in color, shaded glyphs without
    const solid = (x: string): string => x.replace(/[▓▒░]/g, '█');
    expect(solid(stripAnsi(tc))).toBe(solid(plain));
    expect(solid(stripAnsi(c256))).toBe(solid(plain));
  });

  it('tags estimates and explains subscription amounts', () => {
    const ru = renderTerminal(sampleReport, { color: 'none', width: 90 });
    expect(ru).toContain('◆ agento audit');
    expect(ru).toContain('API-эквиваленте');
    expect(ru).toContain('оценка');
    expect(ru).toContain('факт');
    expect(ru).toContain('╭─ Топ действий');
    expect(ru).toContain('╰');
    const api = clone(sampleReport) as AuditReport;
    api.meta.plan = 'api';
    const apiText = renderTerminal(api, { color: 'none', width: 90 });
    expect(apiText).not.toContain('API-эквиваленте');
    expect(apiText).not.toContain('по неделям');
    expect(renderTerminal(sampleReportEn, { color: 'none', width: 90 })).toContain('API-equivalent');
  });

  it('shows why a model switch never pays back', () => {
    const text = renderTerminal(sampleReport, { color: 'none', width: 90 });
    expect(text).toContain('никогда');
    expect(text).toContain('11 шагов');
  });

  it('prints break-even as whole steps with the right Russian plural, never a raw float', () => {
    const r = clone(sampleReport) as AuditReport;
    const steps = [1, 2, 4, 5, 11, 12, 21, 22, 75.39017521503663, 7.203526959610926, 33.56324459741951, 0.2];
    r.switchSim.rows = steps.map((n) => ({ from: 'opus-5.5', to: 'sonnet-5.5', prefixTokens: 1000, penalty: 0.5, savingPerStep: 0.01, breakEvenSteps: n }));
    const text = renderTerminal(r, { color: 'none', width: 100 });
    for (const want of ['1 шаг', '2 шага', '4 шага', '5 шагов', '11 шагов', '12 шагов', '21 шаг', '22 шага', '76 шагов', '8 шагов', '34 шага']) expect(text).toMatch(new RegExp(`${want}(\\s|$)`, 'm'));
    expect(text).not.toMatch(/\d\.\d{4,}/);
    for (const x of [renderMarkdown(r), renderTerminal({ ...r, meta: { ...r.meta, lang: 'en' } }, { color: 'none', width: 100 })]) expect(x).not.toMatch(/\d\.\d{4,}/);
    expect(renderMarkdown(r)).toContain('76 шагов');
    const en = clone(r) as AuditReport;
    en.meta.lang = 'en';
    expect(renderMarkdown(en)).toMatch(/\| 1 step \|/);
    expect(renderMarkdown(en)).toContain('| 76 steps |');
  });

  it('prints the header in local time', () => {
    const text = renderTerminal(sampleReport, { color: 'none', width: 90 });
    expect(text.split('\n')[0]).toMatch(/2026-10-05 17:02$/);
    expect(renderMarkdown(sampleReport)).toContain('· 2026-10-05 17:02');
  });

  it('shows the median reconciliation deviation, and the worst one only below 100%', () => {
    const ru = renderTerminal(sampleReport, { color: 'none', width: 100 });
    expect(ru).toContain('медианное отклонение 2%, худшее 17%');
    const r = clone(sampleReport) as AuditReport;
    r.spend.reconciliation = { sessionsChecked: 10, withinTolerance: 9, medianDeviation: 0.031, worstDeviation: 178.83 };
    const hidden = renderTerminal(r, { color: 'none', width: 100 });
    expect(hidden).toContain('медианное отклонение 3%');
    expect(hidden).not.toContain('худшее');
    expect(hidden).not.toContain('17883');
    r.meta.lang = 'en';
    expect(renderMarkdown(r)).toContain('median deviation 3%');
    expect(renderMarkdown(r)).not.toContain('worst');
    r.spend.reconciliation.worstDeviation = 0.4;
    expect(renderMarkdown(r)).toContain('median deviation 3%, worst 40%');
  });

  it('renders subagent types and both candidate groups, the sonnet one as an upper bound', () => {
    const ru = flat(renderTerminal(sampleReport, { color: 'none', width: 100 }));
    expect(ru).toContain('по типам');
    expect(ru).toMatch(/general-purpose\s+1 210\s+\$27\.80/);
    expect(ru).toContain('Explore');
    expect(ru).toContain('95 general-purpose субагентов на Opus/Fable стоили $18.40, на Sonnet ≈ $9.10, верхняя оценка,');
    expect(ru).toContain('640 Explore-субагентов (или только чтение) на дорогих моделях стоили $25.60');
    const en = flat(renderTerminal(sampleReportEn, { color: 'none', width: 100 }));
    expect(en).toContain('on Sonnet ≈ $9.10, upper bound,');
    const md = renderMarkdown(sampleReport);
    expect(md).toContain('| `general-purpose` | 1 210 | $27.80 |');
    expect(md).toContain('верхняя оценка');
    const none = clone(sampleReport) as AuditReport;
    none.subagents.sonnetCandidates = { count: 0, cost: 0, asSonnet: 0 };
    none.subagents.byType = [];
    expect(renderTerminal(none, { color: 'none', width: 100 })).not.toContain('по типам');
  });

  it('shows CLAUDE.md with tokens and monthly read cost, paths with ~', () => {
    const text = renderTerminal(sampleReport, { color: 'none', width: 100 });
    expect(text).toMatch(/~\/Projects\/billing-api\/CLAUDE\.md\s+60\.4 КБ\s+≈ 17\.2k\s+\$29\.40\/мес/);
    const md = renderMarkdown(sampleReport);
    expect(md).toContain('| `~/Projects/billing-api/CLAUDE.md` | 60.4 КБ | ≈ 17.2k | $29.40/мес |');
    const home = clone(sampleReport) as AuditReport;
    home.setup.claudeMd[0]!.path = join(homedir(), 'p', 'CLAUDE.md');
    expect(renderTerminal(home, { color: 'none', width: 100 })).toContain('~/p/CLAUDE.md');
    expect(renderMarkdown(home)).toContain('`~/p/CLAUDE.md`');
  });

  it('calls the dead-context figure an upper bound', () => {
    expect(flat(renderTerminal(sampleReport, { color: 'none', width: 100 }))).toContain('до ≈ $14.60, если бы после смены темы начинали с /clear');
    expect(flat(renderTerminal(sampleReportEn, { color: 'none', width: 100 }))).toContain('up to ≈ $14.60 if you had started with /clear');
    expect(renderMarkdown(sampleReport)).toContain('до ≈ **$14.60**');
  });

  it('survives long CJK/emoji prompts and empty sections', () => {
    const r = clone(sampleReport) as AuditReport;
    r.tasks.topExamples[0]!.firstPrompt = '日本語のとても長い質問です 😀😀 '.repeat(20);
    for (const w of [64, 100]) for (const l of lines(renderTerminal(r, { color: 'none', width: w }))) expect(visWidth(l)).toBeLessThanOrEqual(w);

    const empty = makeSampleReport('en');
    empty.spend.byFamily = [];
    empty.spend.byDay = [];
    empty.spend.byWeek = [];
    empty.spend.byProject = [];
    empty.spend.effortMix = [];
    empty.spend.total = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
    empty.cache.losses = [];
    empty.ttl.gapHistogram = [];
    empty.ttl.recommendation = null;
    empty.tasks = { count: 0, light: 0, lightOnExpensive: { count: 0, cost: 0, asSonnet: 0 }, maxEffortOnLight: 0, topExamples: [] };
    empty.subagents = { share: 0, calls: 0, cost: 0, byFamily: [], byType: [], haikuCandidates: { count: 0, cost: 0, asHaiku: 0 }, sonnetCandidates: { count: 0, cost: 0, asSonnet: 0 } };
    empty.setup.claudeMd = [];
    empty.switchSim.rows = [];
    empty.actions = [];
    const text = renderTerminal(empty, { color: 'none', width: 64 });
    expect(text).toContain('No obvious savings found.');
    for (const l of lines(text)) expect(visWidth(l)).toBeLessThanOrEqual(64);
    expect(() => renderMarkdown(empty)).not.toThrow();
    expect(() => renderJson(empty)).not.toThrow();
  });
});

describe('renderMarkdown', () => {
  it('snapshot ru', () => expect(renderMarkdown(sampleReport)).toMatchSnapshot());
  it('snapshot en', () => expect(renderMarkdown(sampleReportEn)).toMatchSnapshot());

  it('has well-formed tables and no ANSI', () => {
    const md = renderMarkdown(sampleReport);
    expect(md).not.toContain('\x1b');
    expect(md.endsWith('\n')).toBe(true);
    const rows = lines(md).filter((l) => l.startsWith('|'));
    expect(rows.length).toBeGreaterThan(20);
    // consecutive table rows must share a column count
    let prev = -1;
    for (const l of lines(md)) {
      if (!l.startsWith('|')) {
        prev = -1;
        continue;
      }
      const cols = l.replace(/\\\|/g, '').split('|').length;
      if (prev !== -1) expect(cols, l).toBe(prev);
      prev = cols;
    }
  });
});

// Minimal JSON Schema checker covering the keywords used by docs/audit-schema.json.
type Schema = Record<string, any>;
function validate(schema: Schema, value: unknown, root: Schema, path = '$'): string[] {
  if (schema.$ref) return validate(String(schema.$ref).split('/').slice(1).reduce((s: any, k: string) => s[k], root), value, root, path);
  const errs: string[] = [];
  if (schema.oneOf) {
    const ok = (schema.oneOf as Schema[]).filter((s) => validate(s, value, root, path).length === 0).length;
    return ok === 1 ? [] : [`${path}: oneOf matched ${ok}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  const types = schema.type ? ([] as string[]).concat(schema.type) : [];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) return [`${path}: expected ${types}, got ${actual}`];
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: < minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: > maximum`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) errs.push(`${path}.${k}: missing`);
    for (const [k, v] of Object.entries(o)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unexpected`);
    }
  }
  return errs;
}

describe('renderJson and schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../../docs/audit-schema.json', import.meta.url), 'utf8')) as Schema;

  it('round-trips and uses 2-space indent', () => {
    const text = renderJson(sampleReport);
    expect(text.startsWith('{\n  "meta": {')).toBe(true);
    expect(text.endsWith('\n')).toBe(false);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(sampleReport)));
  });

  it('is independent of input key order', () => {
    const shuffled = JSON.parse(JSON.stringify(sampleReport), function (this: unknown, _k, v: unknown) {
      return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v;
    }) as AuditReport;
    expect(renderJson(shuffled)).toBe(renderJson(sampleReport));
    expect(Object.keys(JSON.parse(renderJson(shuffled)))).toEqual(['meta', 'spend', 'cache', 'ttl', 'tasks', 'subagents', 'deadContext', 'setup', 'switchSim', 'actions']);
  });

  it('validates against docs/audit-schema.json', () => {
    expect(validate(schema, JSON.parse(renderJson(sampleReport)), schema)).toEqual([]);
    expect(validate(schema, JSON.parse(renderJson(sampleReportEn)), schema)).toEqual([]);
  });

  it('the validator itself rejects broken reports', () => {
    const bad = JSON.parse(renderJson(sampleReport));
    delete bad.cache;
    bad.meta.plan = 'free';
    expect(validate(schema, bad, schema).length).toBeGreaterThanOrEqual(2);
  });
});
