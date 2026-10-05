import { describe, expect, it } from 'vitest';
import { buildActions, plural } from '../src/audit/actions.ts';
import { buildReport } from '../src/audit/index.ts';
import type { AuditReport } from '../src/types.ts';
import { call, corpus, session } from './corpus-builder.ts';
import { makeSampleReport } from './sample-report.ts';

type Sections = Omit<AuditReport, 'actions' | 'meta'>;

const empty = (lang: 'ru' | 'en' = 'ru'): Sections => {
  const { actions: _a, meta: _m, ...s } = makeSampleReport(lang);
  return {
    ...s,
    tasks: { ...s.tasks, lightOnExpensive: { count: 0, cost: 0, asSonnet: 0 } },
    subagents: { ...s.subagents, haikuCandidates: { count: 0, cost: 0, asHaiku: 0 }, sonnetCandidates: { count: 0, cost: 0, asSonnet: 0 } },
    deadContext: { events: 0, cost: 0 },
    ttl: { ...s.ttl, recommendation: null },
    cache: { ...s.cache, losses: [] },
    setup: { ...s.setup, claudeMd: [] },
  };
};
const ids = (a: Array<{ id: string }>): string[] => a.map((x) => x.id);

describe('plural', () => {
  it.each([
    [0, 'раз'],
    [1, 'раз'],
    [2, 'раза'],
    [4, 'раза'],
    [5, 'раз'],
    [11, 'раз'],
    [12, 'раз'],
    [14, 'раз'],
    [21, 'раз'],
    [22, 'раза'],
    [25, 'раз'],
    [101, 'раз'],
    [111, 'раз'],
    [112, 'раз'],
    [122, 'раза'],
  ])('%i -> %s', (n, form) => expect(plural(n, 'раз', 'раза', 'раз')).toBe(form));

  it('picks all three forms', () => {
    expect([1, 2, 5, 11, 21, 24, 100].map((n) => plural(n, 'задача', 'задачи', 'задач'))).toEqual(['задача', 'задачи', 'задач', 'задач', 'задача', 'задачи', 'задач']);
    expect(plural(3, 'субагент', 'субагента', 'субагентов')).toBe('субагента');
    expect(plural(-2, 'a', 'b', 'c')).toBe('b');
  });
});

describe('buildActions', () => {
  it('agrees counts in Russian details', () => {
    const detail = (n: number): string => {
      const s = empty();
      s.tasks.lightOnExpensive = { count: n, cost: 10, asSonnet: 1 };
      return buildActions(s, 30, 'ru').find((a) => a.id === 'light-tasks-sonnet')!.detail;
    };
    expect(detail(1)).toMatch(/^1 лёгкая задача выполнена на Opus/);
    expect(detail(2)).toMatch(/^2 лёгкие задачи выполнены на Opus/);
    expect(detail(5)).toMatch(/^5 лёгких задач выполнено на Opus/);
    expect(detail(21)).toMatch(/^21 лёгкая задача выполнена/);

    const sub = (n: number): string => {
      const s = empty();
      s.subagents.haikuCandidates = { count: n, cost: 10, asHaiku: 1 };
      return buildActions(s, 30, 'ru')[0]!.detail;
    };
    expect(sub(1)).toMatch(/^1 субагент \(Explore или только чтение\) работал/);
    expect(sub(3)).toMatch(/^3 субагента \(.*\) работали/);
    expect(sub(11)).toMatch(/^11 субагентов \(.*\) работали/);

    const sw = (n: number): string => {
      const s = empty();
      s.cache.losses = [{ cause: 'model-switch', events: n, cost: 9 }];
      return buildActions(s, 30, 'ru')[0]!.detail;
    };
    expect(sw(1)).toMatch(/^1 раз смена/);
    expect(sw(4)).toMatch(/^4 раза смена/);
    expect(sw(5)).toMatch(/^5 раз смена/);
    const dead = (n: number): string => {
      const s = empty();
      s.deadContext = { events: n, cost: 30 };
      return buildActions(s, 30, 'ru')[0]!.detail;
    };
    expect(dead(2)).toMatch(/^2 раза новая тема/);
    expect(dead(128)).toMatch(/^128 раз новая тема/);
  });

  it('agrees counts in English too', () => {
    const s = empty('en');
    s.tasks.lightOnExpensive = { count: 1, cost: 10, asSonnet: 1 };
    s.cache.losses = [{ cause: 'model-switch', events: 1, cost: 9 }];
    const a = buildActions(s, 30, 'en');
    expect(a.find((x) => x.id === 'light-tasks-sonnet')!.detail).toMatch(/^1 light task ran/);
    expect(a.find((x) => x.id === 'no-mid-session-switch')!.detail).toMatch(/^1 model switch forced/);
  });

  it('adds a subagents-sonnet action from sonnetCandidates, scaled to 30 days', () => {
    const s = empty();
    s.subagents.sonnetCandidates = { count: 22, cost: 60, asSonnet: 30 };
    const a = buildActions(s, 15, 'ru');
    expect(ids(a)).toEqual(['subagents-sonnet']);
    expect(a[0]!.monthly).toEqual({ usd: 60, kind: 'estimate' });
    expect(a[0]!.title).toContain('general-purpose');
    expect(a[0]!.detail).toMatch(/^22 субагента general-purpose работали на Opus\/Fable; верхняя оценка/);
    expect(buildActions(s, 15, 'en')[0]!.detail).toContain('upper bound');
  });

  it('states that the /clear saving is an upper bound, with the amount', () => {
    const s = empty();
    s.deadContext = { events: 37, cost: 45 };
    const [ru] = buildActions(s, 30, 'ru');
    expect(ru!.detail).toContain('до ≈ $45.00/мес, если бы после смены темы начинали с /clear');
    expect(ru!.monthly.usd).toBe(45);
    expect(buildActions({ ...s }, 30, 'en')[0]!.detail).toContain('up to ≈ $45.00/mo if you had started with /clear');
  });

  describe('trim-claude-md', () => {
    const md = (path: string, bytes: number, monthlyReadCost: number, trimSaving: number) => ({ path, bytes, tokens: bytes / 3.6, monthlyReadCost, trimSaving });

    it('picks the file with the biggest saving, titled with ~ path and size in KB', () => {
      const s = empty();
      s.setup.claudeMd = [md('/p/small/CLAUDE.md', 9_000, 6, 0), md('/p/a/CLAUDE.md', 61_440, 30, 21), md('/p/b/CLAUDE.md', 40_960, 12, 6)];
      const a = buildActions(s, 30, 'ru').find((x) => x.id === 'trim-claude-md')!;
      expect(a.title).toBe('Сократить a/CLAUDE.md (60 КБ)');
      expect(a.monthly).toEqual({ usd: 21, kind: 'estimate' });
      expect(a.detail).toContain('перечитывается из кэша на каждом запросе');
      expect(a.detail).toContain('≈ 17.1k токенов');
      expect(a.detail).toContain('$30.00/мес');
      expect(buildActions(s, 30, 'en').find((x) => x.id === 'trim-claude-md')!.title).toBe('Trim a/CLAUDE.md (60 KB)');
    });

    it('shortens the path to the project folder', async () => {
      const { homedir } = await import('node:os');
      const s = empty();
      s.setup.claudeMd = [md(`${homedir()}/proj/CLAUDE.md`, 51_200, 10, 5)];
      expect(buildActions(s, 30, 'en')[0]!.title).toBe('Trim proj/CLAUDE.md (50 KB)');
    });

    it('needs a monthly read cost of at least $1 and a positive saving', () => {
      const s = empty();
      s.setup.claudeMd = [md('/p/a/CLAUDE.md', 61_440, 0.99, 0.7)];
      expect(ids(buildActions(s, 30, 'ru'))).toEqual([]);
      s.setup.claudeMd = [md('/p/a/CLAUDE.md', 10_000, 5, 0)];
      expect(ids(buildActions(s, 30, 'ru'))).toEqual([]);
      s.setup.claudeMd = [md('/p/a/CLAUDE.md', 61_440, 1, 0.7)];
      expect(ids(buildActions(s, 30, 'ru'))).toEqual(['trim-claude-md']);
    });
  });

  it('sorts by saving and keeps the top 5', () => {
    const s = makeSampleReport('ru');
    const a = buildActions({ ...s }, 30, 'ru');
    expect(a.length).toBeLessThanOrEqual(5);
    expect(a.map((x) => x.monthly.usd)).toEqual([...a.map((x) => x.monthly.usd)].sort((x, y) => y - x));
  });

  it('flows through buildReport', () => {
    const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 10 };
    const c = corpus([session({ calls: [call({ usage })] })]);
    const r = buildReport(c, { lang: 'ru', now: Date.UTC(2026, 9, 5) });
    expect(r.spend.reconciliation.medianDeviation).toBe(0);
    expect(r.subagents.sonnetCandidates).toEqual({ count: 0, cost: 0, asSonnet: 0 });
    expect(r.setup.claudeMd).toEqual([]);
  });
});
