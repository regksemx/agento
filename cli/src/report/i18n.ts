// String tables. Every renderer reads text only from here; ru is the primary language.

import type { MissCause, Ttl } from '../types.ts';
import { plural as ruPlural } from '../audit/actions.ts';
import { groupThousands, pct } from './format.ts';

export type Lang = 'ru' | 'en';

export interface Strings {
  lang: Lang;
  estimate: string;
  fact: string;
  perMonth: string;
  never: string;
  kb: string;
  mb: string;
  tokensUnit: string;
  months: string[];
  n(n: number): string;
  days(n: number): string;
  since(d: string): string;
  sessions(n: number): string;
  requests(n: number): string;
  priceDate(d: string): string;
  subscriptionNote: string;
  localNote: string;
  dataQuality(p: { dup: number; bad: number; unknown: number }): string | null;

  title: { spend: string; buckets: string; cache: string; ttl: string; tasks: string; subagents: string; dead: string; setup: string; switch: string; actions: string };
  hint: { spend: string; buckets: string; cache: string; ttl: string; tasks: string; subagents: string; dead: string; setup: string; switch: string };

  col: { model: string; requests: string; cost: string; share: string; project: string; sessions: string; week: string; bucket: string; cause: string; events: string; gap: string; count: string; file: string; size: string; action: string; saving: string; effort: string; task: string; model1: string; type: string; tokens: string; readCost: string },
  spend: {
    main: string;
    subagents: string;
    byDay: string;
    peak: string;
    byWeek: string;
    weekHint: string;
    projects: string;
    more(n: number): string;
    fast: string;
    effort: string;
    reconcile(checked: number, within: number, median: number, worst: number): string;
  };
  buckets: { cacheWrite: string; cacheRead: string; output: string; input: string };
  cache: { hit: string; hitHint: string; losses: string; none: string; cause: Record<MissCause, string>; events(n: number): string };
  ttl: { now: string; suggest: string; observed(t: Ttl | 'mixed' | 'unknown'): string; name(t: Ttl): string; gaps: string; saving: string };
  tasks: {
    summary(count: number, light: number, share: string): string;
    lightOnExpensive: string;
    asSonnet(cost: string): string;
    maxEffort: string;
    examples: string;
    calls(n: number): string;
  };
  subagents: {
    summary(share: string, calls: number, cost: string): string;
    byType: string;
    candidates(count: number, cost: string, asHaiku: string): string;
    sonnetCandidates(count: number, cost: string, asSonnet: string): string;
    saving: string;
    upperBound: string;
  };
  dead: { summary(events: number, cost: string): string; advice: string };
  setup: { prefix(tokens: string): string; perPeriod: string; claudeMd: string; adviceHeavy: string; readNote: string };
  sw: { pair: string; prefix: string; penalty: string; saving: string; breakEven: string; steps(n: number): string; note: string };
  actions: { total(sum: string, share: string): string; overlap: string; empty: string };
}

const ru: Strings = {
  lang: 'ru',
  estimate: 'оценка',
  fact: 'факт',
  perMonth: '/мес',
  never: 'никогда',
  kb: 'КБ',
  mb: 'МБ',
  tokensUnit: 'токенов',
  months: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  n: (n) => groupThousands(n, ' '),
  days: (n) => `${Math.round(n)} ${ruPlural(n, 'день', 'дня', 'дней')}`,
  since: (d) => `с ${d}`,
  sessions: (n) => `${groupThousands(n, ' ')} ${ruPlural(n, 'сессия', 'сессии', 'сессий')}`,
  requests: (n) => `${groupThousands(n, ' ')} ${ruPlural(n, 'запрос', 'запроса', 'запросов')}`,
  priceDate: (d) => `цены API на ${d}`,
  subscriptionNote: 'Суммы в API-эквиваленте: по подписке деньги не списываются, реальный предел — недельный лимит.',
  localNote: 'Всё посчитано локально, ничего не отправлялось.',
  dataQuality: ({ dup, bad, unknown }) => {
    const p: string[] = [];
    if (dup) p.push(`${groupThousands(dup, ' ')} ${ruPlural(dup, 'дубль отброшен', 'дубля отброшено', 'дублей отброшено')}`);
    if (bad) p.push(`${bad} ${ruPlural(bad, 'битая строка', 'битые строки', 'битых строк')}`);
    if (unknown) p.push(`${unknown} ${ruPlural(unknown, 'запрос', 'запроса', 'запросов')} неизвестных моделей не учтено`);
    return p.length ? p.join(' · ') : null;
  },

  title: {
    spend: 'Расход',
    buckets: 'Корзины',
    cache: 'Кэш',
    ttl: 'TTL кэша',
    tasks: 'Задачи',
    subagents: 'Субагенты',
    dead: 'Мёртвый контекст',
    setup: 'Настройка',
    switch: 'Переключение модели',
    actions: 'Топ действий',
  },
  hint: {
    spend: 'Во что обошлись токены по прайсу API.',
    buckets: 'Из чего складывается счёт. Запись в кэш дороже чтения в разы.',
    cache: 'Доля контекста, прочитанного из кэша, и цена промахов.',
    ttl: 'Как долго живёт кэш и как часто вы делаете паузы дольше.',
    tasks: 'Лёгкие задачи на дорогих моделях и лишний effort.',
    subagents: 'Фоновые агенты: у них свой кэш, модель выбирается свободно.',
    dead: 'Перечитывание старого контекста после смены темы.',
    setup: 'Фиксированный префикс, который платится на каждом старте.',
    switch: 'Что стоило бы переключение модели посреди задачи.',
  },

  col: { model: 'Модель', requests: 'Запросов', cost: 'Расход', share: 'Доля', project: 'Проект', sessions: 'Сессий', week: 'Неделя с', bucket: 'Корзина', cause: 'Причина', events: 'Случаев', gap: 'Пауза', count: 'Запросов', file: 'Файл', size: 'Размер', action: 'Действие', saving: 'В месяц', effort: 'Effort', task: 'Задача', model1: 'Модель', type: 'Тип', tokens: 'Токенов', readCost: 'Чтение в месяц' },
  spend: {
    main: 'основной поток',
    subagents: 'субагенты',
    byDay: 'по дням',
    peak: 'пик',
    byWeek: 'по неделям',
    weekHint: 'для подписки смотрите на самую тяжёлую неделю',
    projects: 'Проекты',
    more: (n) => `ещё ${n}`,
    fast: 'fast mode',
    effort: 'Effort по расходу',
    reconcile: (c, w, median, worst) => `сверка с cost-state: ${w} из ${c} сессий в пределах ±10%, медианное отклонение ${pct(median)}${worst < 1 ? `, худшее ${pct(worst)}` : ''}`,
  },
  buckets: { cacheWrite: 'запись кэша', cacheRead: 'чтение кэша', output: 'output', input: 'ввод' },
  cache: {
    hit: 'hit ratio',
    hitHint: 'main',
    losses: 'Потери на промахах',
    none: 'потерь не найдено',
    cause: {
      ttl: 'истёк TTL',
      'model-switch': 'смена модели',
      compaction: 'компакция',
      'effort-change': 'смена effort',
      unknown: 'причина неясна',
    },
    events: (n) => `×${groupThousands(n, ' ')}`,
  },
  ttl: {
    now: 'сейчас',
    suggest: 'предлагаем',
    observed: (t) => ({ '5m': '5 минут', '1h': '1 час', mixed: 'смешанный', unknown: 'неизвестно' })[t],
    name: (t) => (t === '1h' ? '1 час' : '5 минут'),
    gaps: 'паузы между запросами',
    saving: 'экономия',
  },
  tasks: {
    summary: (c, l, s) => `${groupThousands(c, ' ')} ${ruPlural(c, 'задача', 'задачи', 'задач')}, из них лёгких ${groupThousands(l, ' ')} (${s})`,
    lightOnExpensive: 'лёгкие на Opus/Fable',
    asSonnet: (cost) => `на Sonnet вышло бы ≈ ${cost}, разница`,
    maxEffort: 'effort max/xhigh на лёгких',
    examples: 'самые дорогие лёгкие',
    calls: (n) => `${n} ${ruPlural(n, 'запрос', 'запроса', 'запросов')}`,
  },
  subagents: {
    summary: (share, calls, cost) => `${share} расхода · ${groupThousands(calls, ' ')} ${ruPlural(calls, 'вызов', 'вызова', 'вызовов')} · ${cost}`,
    byType: 'по типам',
    candidates: (n, cost, asHaiku) => `${groupThousands(n, ' ')} ${ruPlural(n, 'Explore-субагент', 'Explore-субагента', 'Explore-субагентов')} (или только чтение) на дорогих моделях стоили ${cost}, на haiku ≈ ${asHaiku}`,
    sonnetCandidates: (n, cost, asSonnet) => `${groupThousands(n, ' ')} ${ruPlural(n, 'general-purpose субагент', 'general-purpose субагента', 'general-purpose субагентов')} на Opus/Fable стоили ${cost}, на Sonnet ≈ ${asSonnet}`,
    saving: 'разница',
    upperBound: 'верхняя оценка',
  },
  dead: {
    summary: (e, cost) => `${e} ${ruPlural(e, 'раз', 'раза', 'раз')} старый контекст перечитывался после смены темы: до ≈ ${cost}, если бы после смены темы начинали с /clear`,
    advice: '/clear или новая сессия перед новой темой, пока префикс больше 60k',
  },
  setup: {
    prefix: (t) => `стартовый префикс ≈ ${t} токенов ·`,
    perPeriod: 'за период',
    claudeMd: 'CLAUDE.md',
    adviceHeavy: 'CLAUDE.md читается в каждом запросе: после промаха кэша он оплачивается заново',
    readNote: 'токены ≈ байты / 3,6; справа цена чтения из кэша за 30 дней',
  },
  sw: {
    pair: 'переход',
    prefix: 'префикс',
    penalty: 'штраф',
    saving: 'за шаг',
    breakEven: 'окупится',
    steps: (n) => `${Math.ceil(n)} ${ruPlural(Math.ceil(n), 'шаг', 'шага', 'шагов')}`,
    note: 'agento не меняет модель посреди задачи: кэш не переносится, штраф это полная перезапись префикса. Модель выбирается на старте задачи, после /clear и в субагентах.',
  },
  actions: {
    total: (sum, share) => `вместе до ≈ ${sum}/мес (${share} месячного расхода)`,
    overlap: 'оценки пересекаются, это верхняя граница',
    empty: 'Явных точек экономии не найдено.',
  },
};

const en: Strings = {
  lang: 'en',
  estimate: 'estimate',
  fact: 'fact',
  perMonth: '/mo',
  never: 'never',
  kb: 'KB',
  mb: 'MB',
  tokensUnit: 'tokens',
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  n: (n) => groupThousands(n, ','),
  days: (n) => `${n} ${n === 1 ? 'day' : 'days'}`,
  since: (d) => `since ${d}`,
  sessions: (n) => `${groupThousands(n, ',')} ${n === 1 ? 'session' : 'sessions'}`,
  requests: (n) => `${groupThousands(n, ',')} ${n === 1 ? 'request' : 'requests'}`,
  priceDate: (d) => `API prices as of ${d}`,
  subscriptionNote: 'Amounts are API-equivalent: a subscription charges nothing, the real constraint is the weekly limit.',
  localNote: 'Computed locally, nothing was sent anywhere.',
  dataQuality: ({ dup, bad, unknown }) => {
    const p: string[] = [];
    if (dup) p.push(`${groupThousands(dup, ',')} duplicate rows dropped`);
    if (bad) p.push(`${bad} malformed ${bad === 1 ? 'line' : 'lines'}`);
    if (unknown) p.push(`${unknown} ${unknown === 1 ? 'request' : 'requests'} on unknown models not counted`);
    return p.length ? p.join(' · ') : null;
  },

  title: {
    spend: 'Spend',
    buckets: 'Buckets',
    cache: 'Cache',
    ttl: 'Cache TTL',
    tasks: 'Tasks',
    subagents: 'Subagents',
    dead: 'Dead context',
    setup: 'Setup',
    switch: 'Model switch',
    actions: 'Top actions',
  },
  hint: {
    spend: 'What your tokens cost at API list prices.',
    buckets: 'What the bill is made of. Cache writes cost several times a read.',
    cache: 'Share of context served from cache, and what misses cost.',
    ttl: 'How long the cache lives and how often your pauses outlast it.',
    tasks: 'Light tasks on expensive models, and effort you did not need.',
    subagents: 'Background agents: own cache, so any model is safe to pick.',
    dead: 'Re-reading old context after the topic changed.',
    setup: 'The fixed prefix you pay for at every session start.',
    switch: 'What switching the model mid-task would have cost.',
  },

  col: { model: 'Model', requests: 'Requests', cost: 'Cost', share: 'Share', project: 'Project', sessions: 'Sessions', week: 'Week of', bucket: 'Bucket', cause: 'Cause', events: 'Events', gap: 'Gap', count: 'Requests', file: 'File', size: 'Size', action: 'Action', saving: 'Per month', effort: 'Effort', task: 'Task', model1: 'Model', type: 'Type', tokens: 'Tokens', readCost: 'Read per month' },
  spend: {
    main: 'main thread',
    subagents: 'subagents',
    byDay: 'daily',
    peak: 'peak',
    byWeek: 'weekly',
    weekHint: 'on a subscription, watch your heaviest week',
    projects: 'Projects',
    more: (n) => `${n} more`,
    fast: 'fast mode',
    effort: 'Effort by spend',
    reconcile: (c, w, median, worst) => `cost-state check: ${w} of ${c} sessions within ±10%, median deviation ${pct(median)}${worst < 1 ? `, worst ${pct(worst)}` : ''}`,
  },
  buckets: { cacheWrite: 'cache write', cacheRead: 'cache read', output: 'output', input: 'input' },
  cache: {
    hit: 'hit ratio',
    hitHint: 'main',
    losses: 'Losses from misses',
    none: 'no losses found',
    cause: {
      ttl: 'TTL expired',
      'model-switch': 'model switch',
      compaction: 'compaction',
      'effort-change': 'effort change',
      unknown: 'unclear cause',
    },
    events: (n) => `×${groupThousands(n, ',')}`,
  },
  ttl: {
    now: 'now',
    suggest: 'suggested',
    observed: (t) => ({ '5m': '5 minutes', '1h': '1 hour', mixed: 'mixed', unknown: 'unknown' })[t],
    name: (t) => (t === '1h' ? '1 hour' : '5 minutes'),
    gaps: 'gaps between requests',
    saving: 'saving',
  },
  tasks: {
    summary: (c, l, s) => `${groupThousands(c, ',')} ${c === 1 ? 'task' : 'tasks'}, ${groupThousands(l, ',')} of them light (${s})`,
    lightOnExpensive: 'light tasks on Opus/Fable',
    asSonnet: (cost) => `on Sonnet this would be ≈ ${cost}, difference`,
    maxEffort: 'effort max/xhigh on light tasks',
    examples: 'costliest light tasks',
    calls: (n) => `${n} ${n === 1 ? 'call' : 'calls'}`,
  },
  subagents: {
    summary: (share, calls, cost) => `${share} of spend · ${groupThousands(calls, ',')} ${calls === 1 ? 'call' : 'calls'} · ${cost}`,
    byType: 'by type',
    candidates: (n, cost, asHaiku) => `${groupThousands(n, ',')} Explore (or read-only) ${n === 1 ? 'subagent' : 'subagents'} on pricey models cost ${cost}, on haiku ≈ ${asHaiku}`,
    sonnetCandidates: (n, cost, asSonnet) => `${groupThousands(n, ',')} general-purpose ${n === 1 ? 'subagent' : 'subagents'} on Opus/Fable cost ${cost}, on Sonnet ≈ ${asSonnet}`,
    saving: 'difference',
    upperBound: 'upper bound',
  },
  dead: {
    summary: (e, cost) => `${e} ${e === 1 ? 'time' : 'times'} old context was re-read after a topic change: up to ≈ ${cost} if you had started with /clear after each topic change`,
    advice: '/clear or a new session before a new topic, once the prefix passes 60k',
  },
  setup: {
    prefix: (t) => `startup prefix ≈ ${t} tokens ·`,
    perPeriod: 'over the period',
    claudeMd: 'CLAUDE.md',
    adviceHeavy: 'CLAUDE.md is read on every request: after a cache miss you pay for it again',
    readNote: 'tokens ≈ bytes / 3.6; right: cache-read cost per 30 days',
  },
  sw: {
    pair: 'switch',
    prefix: 'prefix',
    penalty: 'penalty',
    saving: 'gain/step',
    breakEven: 'break-even',
    steps: (n) => `${Math.ceil(n)} ${Math.ceil(n) === 1 ? 'step' : 'steps'}`,
    note: 'agento never switches the model mid-task: the cache does not carry over, so the penalty is a full prefix rewrite. The model is picked at task start, after /clear and in subagents.',
  },
  actions: {
    total: (sum, share) => `together up to ≈ ${sum}/mo (${share} of monthly spend)`,
    overlap: 'estimates overlap, so this is an upper bound',
    empty: 'No obvious savings found.',
  },
};

export function strings(lang: Lang): Strings {
  return lang === 'en' ? en : ru;
}

export function dateShort(iso: string, S: Strings): string {
  const [, m, d] = iso.slice(0, 10).split('-');
  const month = S.months[Number(m) - 1] ?? m;
  return S.lang === 'ru' ? `${Number(d)} ${month}` : `${month} ${Number(d)}`;
}
