// Realistic hand-written AuditReport: ~30 days of an opus-heavy subscription user, ~$317 API-equivalent.

import type { Action, AuditReport, CostBreakdown } from '../src/types.ts';

const cb = (input: number, cacheWrite: number, cacheRead: number, output: number): CostBreakdown => ({
  input,
  cacheWrite,
  cacheRead,
  output,
  total: Math.round((input + cacheWrite + cacheRead + output) * 100) / 100,
});

// Relative daily weights (2026-09-06 .. 2026-10-05); weekends are quiet, mid-month had a big refactor.
const DAY_WEIGHTS = [
  2, 7, 9, 11, 10, 12, 3, 1, 8, 12, 14, 13, 9, 2, 0, 10, 13, 15, 12, 8, 3, 2, 11, 16, 24, 18, 12, 4, 6, 12,
];
const TOTAL = 317.2;

function buildDays(): Array<{ date: string; cost: number }> {
  const sum = DAY_WEIGHTS.reduce((a, b) => a + b, 0);
  const start = Date.UTC(2026, 8, 6);
  const days = DAY_WEIGHTS.map((w, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    cost: Math.round(((w / sum) * TOTAL) * 100) / 100,
  }));
  const drift = Math.round((TOTAL - days.reduce((a, d) => a + d.cost, 0)) * 100) / 100;
  days[days.length - 2]!.cost = Math.round((days[days.length - 2]!.cost + drift) * 100) / 100;
  return days;
}

function buildWeeks(days: Array<{ date: string; cost: number }>): Array<{ weekStart: string; cost: number }> {
  const weeks = new Map<string, number>();
  for (const d of days) {
    const t = new Date(d.date + 'T00:00:00Z');
    const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
    const key = new Date(t.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
    weeks.set(key, (weeks.get(key) ?? 0) + d.cost);
  }
  return [...weeks].map(([weekStart, cost]) => ({ weekStart, cost: Math.round(cost * 100) / 100 }));
}

const days = buildDays();

const actionsRu: Action[] = [
  {
    id: 'light-to-sonnet',
    title: 'Лёгкие задачи на Sonnet·medium вместо Opus',
    detail: '392 задачи уложились в 8 запросов и 2 файла правок. Верхняя оценка: Sonnet справится не во всех.',
    monthly: { usd: 38.2, kind: 'estimate' },
  },
  {
    id: 'explore-haiku',
    title: 'Explore-субагенты на haiku',
    detail: '640 поисков по коду шли на Opus и Sonnet: чтение файлов не требует сильной модели.',
    monthly: { usd: 20, kind: 'estimate' },
  },
  {
    id: 'ttl-1h',
    title: 'Кэш на 1 час вместо 5 минут',
    detail: 'У вас 380 пауз дольше часа и 640 от 15 минут: каждая стоила перезаписи контекста.',
    monthly: { usd: 11.4, kind: 'estimate' },
  },
  {
    id: 'clear-new-topic',
    title: '/clear перед новой темой (префикс больше 60k)',
    detail: '37 раз новая тема начиналась в длинном контексте: до ≈ $14.60/мес, если бы после смены темы начинали с /clear.',
    monthly: { usd: 11, kind: 'estimate' },
  },
  {
    id: 'subagents-sonnet',
    title: 'Субагентов general-purpose — на Sonnet',
    detail: '95 субагентов general-purpose работали на Opus/Fable; верхняя оценка: часть таких задач Sonnet не потянет.',
    monthly: { usd: 9.3, kind: 'estimate' },
  },
];

const actionsEn: Action[] = [
  {
    id: 'light-to-sonnet',
    title: 'Light tasks on Sonnet·medium instead of Opus',
    detail: '392 tasks fit into 8 requests and 2 edited files. Upper bound: Sonnet will not handle every one.',
    monthly: { usd: 38.2, kind: 'estimate' },
  },
  {
    id: 'explore-haiku',
    title: 'Explore subagents on haiku',
    detail: '640 code searches ran on Opus and Sonnet: reading files does not need a strong model.',
    monthly: { usd: 20, kind: 'estimate' },
  },
  {
    id: 'ttl-1h',
    title: '1-hour cache instead of 5 minutes',
    detail: 'You had 380 pauses over an hour and 640 over 15 minutes: each one paid for a context rewrite.',
    monthly: { usd: 11.4, kind: 'estimate' },
  },
  {
    id: 'clear-new-topic',
    title: '/clear before a new topic (prefix over 60k)',
    detail: '37 times a new topic started in a long context: up to ≈ $14.60/mo if you had started with /clear after each change.',
    monthly: { usd: 11, kind: 'estimate' },
  },
  {
    id: 'subagents-sonnet',
    title: 'general-purpose subagents on Sonnet',
    detail: '95 general-purpose subagents ran on Opus/Fable; upper bound: Sonnet will not handle every such task.',
    monthly: { usd: 9.3, kind: 'estimate' },
  },
];

export function makeSampleReport(lang: 'ru' | 'en' = 'ru'): AuditReport {
  const ru = lang === 'ru';
  return {
    meta: {
      generatedAt: '2026-10-05T14:02:11.000Z',
      dir: '~/.claude2/projects',
      sessions: 412,
      files: 1284,
      calls: 12408,
      duplicateRowsDropped: 14902,
      badLines: 3,
      unknownModelCalls: 21,
      days: 30,
      pricesAsOf: '2026-10-05',
      plan: 'subscription',
      lang,
    },
    spend: {
      total: cb(6.1, 131.5, 117.2, 62.4),
      main: cb(5.2, 112.9, 101.0, 53.7),
      subagents: cb(0.9, 18.6, 16.2, 8.7),
      byFamily: [
        { family: 'opus-5.5', calls: 7940, cost: cb(4.4, 106.3, 94.6, 50.1) },
        { family: 'opus-5', calls: 1380, cost: cb(0.7, 15.2, 13.1, 6.3) },
        { family: 'sonnet-5.5', calls: 1610, cost: cb(0.55, 6.9, 6.2, 3.4) },
        { family: 'haiku-4.5', calls: 1478, cost: cb(0.45, 3.1, 3.3, 2.6) },
      ],
      byProject: [
        { project: '~/Projects/agento', cost: 118.4, sessions: 131 },
        { project: '~/Projects/billing-api', cost: 74.2, sessions: 88 },
        { project: '~/Projects/web-dashboard', cost: 52.9, sessions: 74 },
        { project: '~/Work/infra-terraform', cost: 31.5, sessions: 52 },
        { project: '~/Projects/dotfiles', cost: 21.3, sessions: 38 },
        { project: '~/Projects/blog', cost: 12.6, sessions: 21 },
        { project: '/tmp', cost: 6.3, sessions: 8 },
      ],
      byDay: days,
      byWeek: buildWeeks(days),
      fastModeCost: 12.8,
      effortMix: [
        { effort: 'max', calls: 2300, cost: 120.1 },
        { effort: 'xhigh', calls: 3100, cost: 96.4 },
        { effort: 'high', calls: 4200, cost: 71 },
        { effort: 'medium', calls: 1900, cost: 24.3 },
        { effort: 'low', calls: 908, cost: 5.4 },
      ],
      reconciliation: { sessionsChecked: 301, withinTolerance: 288, medianDeviation: 0.02, worstDeviation: 0.17 },
    },
    cache: {
      hitRatio: 0.913,
      rewriteCost: 27.1,
      losses: [
        { cause: 'ttl', events: 212, cost: 14.2 },
        { cause: 'model-switch', events: 48, cost: 6.3 },
        { cause: 'compaction', events: 61, cost: 4.9 },
        { cause: 'effort-change', events: 9, cost: 0.9 },
        { cause: 'unknown', events: 14, cost: 0.8 },
      ],
    },
    ttl: {
      observed: '5m',
      gapHistogram: [
        { label: '<1m', count: 6120 },
        { label: '1–5m', count: 2980 },
        { label: '5–15m', count: 1010 },
        { label: '15–60m', count: 640 },
        { label: '>60m', count: 380 },
      ],
      recommendation: {
        ttl: '1h',
        monthlySaving: { usd: 11.4, kind: 'estimate' },
        reason: ru
          ? 'Наценка 2× на запись окупается: 1 020 пауз от 5 до 60 минут стоили больше.'
          : 'The 2× write premium pays for itself: 1,020 pauses of 5 to 60 minutes cost more.',
      },
    },
    tasks: {
      count: 1034,
      light: 540,
      lightOnExpensive: { count: 392, cost: 71.8, asSonnet: 33.6 },
      maxEffortOnLight: 112,
      topExamples: [
        {
          sessionId: 's-7f3a',
          startTs: Date.UTC(2026, 8, 24, 9, 12),
          endTs: Date.UTC(2026, 8, 24, 9, 31),
          model: 'claude-opus-5-5-20260801',
          effort: 'max',
          mainCalls: 6,
          filesEdited: 1,
          outputTokens: 2100,
          errors: 0,
          cost: 4.62,
          isLight: true,
          firstPrompt: ru
            ? 'поправь опечатку в заголовке README и обнови бейдж сборки, ссылка поехала после переименования репозитория'
            : 'fix the typo in the README heading and update the build badge, the link broke after the repo rename',
        },
        {
          sessionId: 's-91bc',
          startTs: Date.UTC(2026, 8, 18, 15, 2),
          endTs: Date.UTC(2026, 8, 18, 15, 20),
          model: 'claude-opus-5-5',
          effort: 'xhigh',
          mainCalls: 8,
          filesEdited: 2,
          outputTokens: 3900,
          errors: 1,
          cost: 3.87,
          isLight: true,
          firstPrompt: ru ? 'переименуй переменную userId в accountId во всём модуле биллинга' : 'rename the userId variable to accountId across the billing module',
        },
        {
          sessionId: 's-02de',
          startTs: Date.UTC(2026, 8, 29, 11, 40),
          endTs: Date.UTC(2026, 8, 29, 11, 52),
          model: 'claude-opus-5',
          effort: 'max',
          mainCalls: 5,
          filesEdited: 0,
          outputTokens: 1400,
          errors: 0,
          cost: 3.31,
          isLight: true,
          firstPrompt: ru ? 'какая версия node в CI и где это задаётся?' : 'which node version does CI use and where is it set?',
        },
      ],
    },
    subagents: {
      share: 0.14,
      calls: 2204,
      cost: 44.4,
      byFamily: [
        { family: 'opus-5.5', cost: 20.1 },
        { family: 'sonnet-5.5', cost: 15 },
        { family: 'haiku-4.5', cost: 9.3 },
      ],
      byType: [
        { type: 'general-purpose', calls: 1210, cost: 27.8 },
        { type: 'Explore', calls: 640, cost: 9.4 },
        { type: 'workflow-subagent', calls: 310, cost: 5.9 },
        { type: 'fork', calls: 44, cost: 1.3 },
      ],
      haikuCandidates: { count: 640, cost: 25.6, asHaiku: 5.6 },
      sonnetCandidates: { count: 95, cost: 18.4, asSonnet: 9.1 },
    },
    deadContext: { events: 37, cost: 14.6 },
    setup: {
      avgFixedPrefixTokens: 23400,
      fixedPrefixCost: 41.3,
      claudeMd: [
        { path: '~/Projects/billing-api/CLAUDE.md', bytes: 61_800, tokens: 17_167, monthlyReadCost: 29.4, trimSaving: 20.2 },
        { path: '~/Projects/agento/CLAUDE.md', bytes: 9_400, tokens: 2_611, monthlyReadCost: 6.1, trimSaving: 0 },
        { path: '~/.claude2/CLAUDE.md', bytes: 1_100, tokens: 306, monthlyReadCost: 0.7, trimSaving: 0 },
      ],
    },
    switchSim: {
      rows: [
        { from: 'opus-5.5', to: 'sonnet-5.5', prefixTokens: 100_000, penalty: 0.23, savingPerStep: 0.0225, breakEvenSteps: 11 },
        { from: 'opus-5.5', to: 'haiku-4.5', prefixTokens: 100_000, penalty: 0.105, savingPerStep: 0.031, breakEvenSteps: 4 },
        { from: 'sonnet-5.5', to: 'opus-5.5', prefixTokens: 60_000, penalty: 0.15, savingPerStep: -0.0225, breakEvenSteps: null },
        { from: 'opus-5.5', to: 'opus-5', prefixTokens: 60_000, penalty: 0.363, savingPerStep: -0.01, breakEvenSteps: null },
      ],
    },
    actions: ru ? actionsRu : actionsEn,
  };
}

export const sampleReport: AuditReport = makeSampleReport('ru');
export const sampleReportEn: AuditReport = makeSampleReport('en');
