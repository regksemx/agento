import { money, tildify, tokens } from '../report/format.ts';
import type { Action, AuditReport } from '../types.ts';

type Sections = Omit<AuditReport, 'actions' | 'meta'>;

// Russian plural form of the word that follows a count: 1 раз / 2 раза / 5 раз, 11 раз, 21 раз.
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.round(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const en = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const TEXT = {
  ru: {
    light: ['Лёгкие задачи — на Sonnet·medium вместо Opus', (n: number) => `${n} ${plural(n, 'лёгкая задача выполнена', 'лёгкие задачи выполнены', 'лёгких задач выполнено')} на Opus/Fable; agento предложит Sonnet на старте такой задачи`],
    haiku: [
      'Разведку в субагентах — на Haiku',
      (n: number) => `${n} ${plural(n, 'субагент', 'субагента', 'субагентов')} (Explore или только чтение) ${plural(n, 'работал', 'работали', 'работали')} на дорогой модели, а Haiku хватило бы`,
    ],
    sonnet: [
      'Субагентов general-purpose — на Sonnet',
      (n: number) => `${n} ${plural(n, 'субагент general-purpose работал', 'субагента general-purpose работали', 'субагентов general-purpose работали')} на Opus/Fable; верхняя оценка: часть таких задач Sonnet не потянет`,
    ],
    dead: [
      '/clear перед новой темой',
      (n: number, usd: number) => `${n} ${plural(n, 'раз', 'раза', 'раз')} новая тема начиналась в длинном контексте: до ≈ ${money(usd)}/мес, если бы после смены темы начинали с /clear`,
    ],
    ttl: ['Кэш на 1 час', () => 'Паузы 5–60 минут сбрасывают 5-минутный кэш; 1h TTL окупается'],
    switch: ['Не менять модель посреди сессии', (n: number) => `${n} ${plural(n, 'раз', 'раза', 'раз')} смена модели заставила заново записать весь контекст в кэш`],
    trim: [
      (path: string, kb: number) => `Сократить ${path} (${kb} КБ)`,
      (tok: string, read: number) => `Файл перечитывается из кэша на каждом запросе (≈ ${tok} токенов, ≈ ${money(read)}/мес); столько сэкономит сокращение до 20 КБ. Предложение по сокращению: /agento:tune`,
    ],
  },
  en: {
    light: ['Light tasks on Sonnet·medium instead of Opus', (n: number) => `${n} light ${en(n, 'task', 'tasks')} ran on Opus/Fable; agento will suggest Sonnet when such a task starts`],
    haiku: [
      'Exploration subagents on Haiku',
      (n: number) => `${n} ${en(n, 'subagent', 'subagents')} (Explore or read-only) ran on an expensive model; Haiku would have done`,
    ],
    sonnet: [
      'general-purpose subagents on Sonnet',
      (n: number) => `${n} general-purpose ${en(n, 'subagent', 'subagents')} ran on Opus/Fable; upper bound: Sonnet will not handle every such task`,
    ],
    dead: [
      '/clear before a new topic',
      (n: number, usd: number) => `${n} ${en(n, 'time', 'times')} a new topic started in a long context: up to ≈ ${money(usd)}/mo if you had started with /clear after each topic change`,
    ],
    ttl: ['1-hour prompt cache', () => '5–60 minute pauses expire the 5-minute cache; a 1h TTL pays off'],
    switch: ['Avoid switching models mid-session', (n: number) => `${n} model ${en(n, 'switch', 'switches')} forced a full cache rewrite of the context`],
    trim: [
      (path: string, kb: number) => `Trim ${path} (${kb} KB)`,
      (tok: string, read: number) => `The file is re-read from cache on every request (≈ ${tok} tokens, ≈ ${money(read)}/mo); trimming it to 20 KB saves this much. Get a proposal with /agento:tune`,
    ],
  },
} as const;

const MIN_MONTHLY_USD = 0.5;

// `~/work/shop-api/CLAUDE.md` → `shop-api/CLAUDE.md`, so titles fit on one line.
function shortPath(path: string): string {
  const parts = tildify(path).split('/').filter(Boolean);
  const keep = parts.at(-2) === '.claude' ? 3 : 2;
  return parts.slice(-keep).join('/');
}
const MIN_TRIM_READ_USD = 1;

export function buildActions(s: Sections, days: number, lang: 'ru' | 'en'): Action[] {
  const t = TEXT[lang];
  const perMonth = (usd: number) => (usd * 30) / Math.max(1, days);
  const out: Action[] = [];

  const light = s.tasks.lightOnExpensive;
  if (light.count > 0) {
    out.push({ id: 'light-tasks-sonnet', title: t.light[0], detail: t.light[1](light.count), monthly: { usd: perMonth(light.cost - light.asSonnet), kind: 'estimate' } });
  }
  const hc = s.subagents.haikuCandidates;
  if (hc.count > 0) {
    out.push({ id: 'explore-subagents-haiku', title: t.haiku[0], detail: t.haiku[1](hc.count), monthly: { usd: perMonth(hc.cost - hc.asHaiku), kind: 'estimate' } });
  }
  const sc = s.subagents.sonnetCandidates;
  if (sc.count > 0) {
    out.push({ id: 'subagents-sonnet', title: t.sonnet[0], detail: t.sonnet[1](sc.count), monthly: { usd: perMonth(sc.cost - sc.asSonnet), kind: 'estimate' } });
  }
  if (s.deadContext.events > 0) {
    const usd = perMonth(s.deadContext.cost);
    out.push({ id: 'clear-before-new-topic', title: t.dead[0], detail: t.dead[1](s.deadContext.events, usd), monthly: { usd, kind: 'estimate' } });
  }
  const rec = s.ttl.recommendation;
  if (rec && rec.ttl === '1h') {
    out.push({ id: 'cache-ttl-1h', title: t.ttl[0], detail: t.ttl[1](), monthly: rec.monthlySaving });
  }
  const sw = s.cache.losses.find((l) => l.cause === 'model-switch');
  if (sw && sw.events > 0) {
    out.push({ id: 'no-mid-session-switch', title: t.switch[0], detail: t.switch[1](sw.events), monthly: { usd: perMonth(sw.cost), kind: 'estimate' } });
  }
  // The CLAUDE.md most worth trimming: the biggest saving among files that cost at least $1 a month to read.
  const heavy = s.setup.claudeMd.filter((f) => f.monthlyReadCost >= MIN_TRIM_READ_USD).sort((a, b) => b.trimSaving - a.trimSaving)[0];
  if (heavy && heavy.trimSaving > 0) {
    out.push({
      id: 'trim-claude-md',
      title: t.trim[0](shortPath(heavy.path), Math.round(heavy.bytes / 1024)),
      detail: t.trim[1](tokens(heavy.tokens), heavy.monthlyReadCost),
      monthly: { usd: heavy.trimSaving, kind: 'estimate' },
    });
  }

  return out.filter((a) => a.monthly.usd >= MIN_MONTHLY_USD).sort((a, b) => b.monthly.usd - a.monthly.usd).slice(0, 5);
}
