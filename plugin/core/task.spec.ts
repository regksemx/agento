import { describe, expect, it } from 'vitest';
import { classifyRules, extractFeatures, isTaskStart, rulesClassifier, topicShift, type TaskTier } from './task.ts';

const ctx = { contextTokens: 0, isSessionStart: true };

// Expected tier at v1 granularity: the rules never answer 'haiku', so light work is labelled 'sonnet'.
// `heavy` marks prompts that must never be routed below sonnet.
interface Example {
  prompt: string;
  tier: TaskTier;
  heavy?: boolean;
}

const EXAMPLES: Example[] = [
  // light, ru
  { prompt: 'поправь опечатку в README', tier: 'sonnet' },
  { prompt: 'переименуй переменную cnt в count в utils/math.ts', tier: 'sonnet' },
  { prompt: 'обнови версию в package.json до 2.4.0', tier: 'sonnet' },
  { prompt: 'добавь лог в начало функции syncUsers', tier: 'sonnet' },
  { prompt: 'поправь текст кнопки на «Сохранить»', tier: 'sonnet' },
  { prompt: 'добавь комментарий к функции parseConfig', tier: 'sonnet' },
  { prompt: 'отформатируй файл src/api/client.ts', tier: 'sonnet' },
  { prompt: 'в readme.md добавь раздел про установку', tier: 'sonnet' },
  // light, en
  { prompt: 'fix the typo in CONTRIBUTING.md', tier: 'sonnet' },
  { prompt: 'rename getUser to fetchUser across the repo', tier: 'sonnet' },
  { prompt: 'bump the version in package.json to 1.3.0', tier: 'sonnet' },
  { prompt: 'add a log line when the worker starts', tier: 'sonnet' },
  { prompt: 'update the comment above retry() to match the new behavior', tier: 'sonnet' },
  { prompt: 'run prettier on src/index.ts', tier: 'sonnet' },
  { prompt: 'rename the `tmp` variable to `buffer`', tier: 'sonnet' },
  // heavy, ru
  { prompt: 'спроектируй архитектуру очереди задач с ретраями', tier: 'opus', heavy: true },
  { prompt: 'нужно мигрировать базу с MySQL на Postgres без простоя', tier: 'opus', heavy: true },
  { prompt: 'найди и исправь race condition в обработчике платежей', tier: 'opus', heavy: true },
  { prompt: 'разберись, почему сервис деградирует по производительности под нагрузкой', tier: 'opus', heavy: true },
  { prompt: 'отрефактори модуль авторизации целиком, он стал неподдерживаемым', tier: 'opus', heavy: true },
  { prompt: 'давай обсудим, как лучше организовать кэширование ответов', tier: 'opus' },
  { prompt: 'как лучше хранить сессии: JWT или серверные?', tier: 'opus' },
  { prompt: 'спроектируй схему базы для мультитенантного биллинга', tier: 'opus', heavy: true },
  { prompt: 'нужно реализовать распределённую блокировку для воркеров', tier: 'opus', heavy: true },
  { prompt: 'продумай план перехода на event sourcing', tier: 'opus' },
  { prompt: 'разработай стратегию миграции данных между шардами', tier: 'opus', heavy: true },
  // heavy, en
  { prompt: 'design a distributed rate limiter on top of Redis', tier: 'opus', heavy: true },
  { prompt: 'design the architecture for a plugin system', tier: 'opus', heavy: true },
  { prompt: 'there is a deadlock between the scheduler and the worker pool, find it', tier: 'opus', heavy: true },
  { prompt: 'migrate the codebase from CommonJS to ESM', tier: 'opus', heavy: true },
  { prompt: 'what are the options for handling auth across microservices?', tier: 'opus', heavy: true },
  { prompt: "let's brainstorm an approach for offline sync", tier: 'opus' },
  { prompt: 'memory leak in the websocket server under load, investigate', tier: 'opus', heavy: true },
  { prompt: 'optimize the performance of the query planner, it is too slow', tier: 'opus', heavy: true },
  { prompt: 'refactor the billing module so invoices and payments are separate', tier: 'opus', heavy: true },
  // ordinary work: no strong signal, sonnet
  { prompt: 'почему падает тест auth.spec, разберись', tier: 'sonnet' },
  { prompt: 'добавь пагинацию в список заказов', tier: 'sonnet' },
  { prompt: 'implement a /health endpoint that returns the git sha', tier: 'sonnet' },
  { prompt: 'fix the failing build on CI', tier: 'sonnet' },
  { prompt: 'напиши юнит-тесты для функции parseDuration', tier: 'sonnet' },
  { prompt: 'add a --verbose flag to the CLI', tier: 'sonnet' },
  { prompt: 'исправь баг: при пустом списке падает рендер таблицы', tier: 'sonnet' },
  { prompt: 'why does npm test hang?', tier: 'sonnet' },
  { prompt: 'add a dark mode toggle to the settings page', tier: 'sonnet' },
  { prompt: 'сделай эндпоинт для экспорта пользователей в CSV', tier: 'sonnet' },
  { prompt: 'write a script that deletes stale git branches', tier: 'sonnet' },
  { prompt: 'добавь валидацию email в форму регистрации', tier: 'sonnet' },
  // known misses: subtle hard work without keywords, and light work that trips a heavy/plan word
  { prompt: 'сделай так, чтобы сервис выдерживал 10k запросов в секунду', tier: 'opus', heavy: true },
  { prompt: 'cache invalidation is subtly wrong when two users edit the same doc', tier: 'opus', heavy: true },
  { prompt: 'добавь в план релиза строку про баг 123', tier: 'sonnet' },
  { prompt: 'rename the design doc to docs/overview.md', tier: 'sonnet' },
];

describe('extractFeatures', () => {
  it('detects language, files, code blocks and length', () => {
    const f = extractFeatures('поправь опечатку в src/app/main.ts и README.md', ctx);
    expect(f.promptLang).toBe('ru');
    expect(f.mentionsFiles).toBe(2);
    expect(f.hasCodeBlock).toBe(false);
    expect(f.promptChars).toBe(46);
    expect(f.isSessionStart).toBe(true);

    const g = extractFeatures('fix this:\n```ts\nconst race = 1;\n```', { contextTokens: 5000, isSessionStart: false });
    expect(g.promptLang).toBe('en');
    expect(g.hasCodeBlock).toBe(true);
    expect(g.contextTokens).toBe(5000);
    expect(extractFeatures('123 ???', ctx).promptLang).toBe('other');
  });

  it('matches Russian stems across word forms, case-insensitively', () => {
    expect(extractFeatures('АРХИТЕКТУРУ переделать', ctx).keywords.heavy).toBe(1);
    expect(extractFeatures('рефакторинг модуля', ctx).keywords.heavy).toBe(1);
    expect(extractFeatures('рефакторинг функции', ctx).keywords.heavy).toBe(0);
    expect(extractFeatures('Отрефактори систему уведомлений', ctx).keywords.heavy).toBe(1);
    expect(extractFeatures('исправь опечатки в тексте', ctx).keywords.light).toBe(1);
    expect(extractFeatures('Переименуй файл', ctx).keywords.light).toBe(1);
  });

  it('matches English words by prefix, exact words only where marked', () => {
    expect(extractFeatures('trace the call', ctx).keywords.heavy).toBe(0); // not "race"
    expect(extractFeatures('a race happens', ctx).keywords.heavy).toBe(1);
    expect(extractFeatures('planet of apes', ctx).keywords.plan).toBe(0);
    expect(extractFeatures('this suits me, подходит', ctx).keywords.plan).toBe(0);
  });

  it('ignores keywords that only appear inside code blocks', () => {
    const f = extractFeatures('fix the failing test:\n```\nconst architecture = migrate();\n```', ctx);
    expect(f.keywords).toEqual({ heavy: 0, light: 0, plan: 0 });
  });
});

describe('classifyRules', () => {
  const verdict = (prompt: string) => classifyRules(extractFeatures(prompt, ctx));

  it('follows the v1 rule table', () => {
    expect(verdict('fix the typo in README')).toMatchObject({ tier: 'sonnet', effort: 'medium', confidence: 0.7 });
    expect(verdict('спроектируй архитектуру')).toMatchObject({ tier: 'opus', effort: 'high', confidence: 0.6 });
    expect(verdict('давай обсудим подход')).toMatchObject({ tier: 'opus', effort: 'high', confidence: 0.6 });
    expect(verdict('почини сборку')).toMatchObject({ tier: 'sonnet', effort: 'high', confidence: 0.4 });
  });

  it('heavy beats light; a long light prompt falls through', () => {
    expect(verdict('rename the module and migrate the data').tier).toBe('opus');
    const long = 'поправь опечатку в README. ' + 'Подробности ниже. '.repeat(30);
    expect(long.length).toBeGreaterThan(400);
    expect(verdict(long)).toMatchObject({ tier: 'sonnet', effort: 'high', confidence: 0.4 });
  });

  it('explains itself', () => {
    expect(verdict('спроектируй архитектуру').reasons.length).toBeGreaterThan(0);
  });

  it('is exposed as an async TaskClassifier', async () => {
    const v = await rulesClassifier.classify('rename foo to bar', ctx);
    expect(v.tier).toBe('sonnet');
  });

  it('labelled examples: accuracy >= 70% and no heavy prompt goes to haiku', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(40);
    let correct = 0;
    const misses: string[] = [];
    for (const e of EXAMPLES) {
      const v = verdict(e.prompt);
      if (v.tier === e.tier) correct += 1;
      else misses.push(`${e.prompt} -> ${v.tier} (want ${e.tier})`);
      if (e.heavy) expect(v.tier, e.prompt).not.toBe('haiku');
    }
    const accuracy = correct / EXAMPLES.length;
    expect(accuracy, misses.join('\n')).toBeGreaterThanOrEqual(0.7);
  });

  it('clearly heavy prompts that carry a keyword are always routed to opus', () => {
    const keyed = EXAMPLES.filter((e) => e.heavy && !/выдерживал|subtly/.test(e.prompt));
    for (const e of keyed) expect(verdict(e.prompt).tier, e.prompt).toBe('opus');
  });
});

describe('isTaskStart', () => {
  const base = { isFirstPrompt: false, markerSinceLastPrompt: null, msSinceLastMainCall: 60_000, ttlMs: 300_000, explicitNew: false } as const;

  it('covers the four rules of spec 4.4', () => {
    expect(isTaskStart({ ...base, isFirstPrompt: true, msSinceLastMainCall: null })).toBe('first-prompt');
    expect(isTaskStart({ ...base, markerSinceLastPrompt: 'compact' })).toBe('compact');
    expect(isTaskStart({ ...base, markerSinceLastPrompt: 'clear' })).toBe('clear');
    expect(isTaskStart({ ...base, msSinceLastMainCall: 300_001 })).toBe('idle');
    expect(isTaskStart({ ...base, explicitNew: true })).toBe('explicit');
  });

  it('is not a task start in the middle of a warm conversation', () => {
    expect(isTaskStart(base)).toBeNull();
    expect(isTaskStart({ ...base, msSinceLastMainCall: 300_000 })).toBeNull();
    expect(isTaskStart({ ...base, msSinceLastMainCall: null })).toBeNull();
  });
});

describe('topicShift', () => {
  it('is near 0 for the same topic and 1 for unrelated prompts', () => {
    const a = 'fix the failing auth middleware test in src/auth/middleware.ts';
    expect(topicShift(a, a)).toBe(0);
    expect(topicShift(a, 'now the auth middleware should also log failed tests')).toBeLessThan(0.85);
    expect(topicShift(a, 'добавь страницу с ценами и форму обратной связи на лендинг')).toBe(1);
  });

  it('collapses Russian word forms and camelCase identifiers', () => {
    expect(topicShift('почини обработчик платежей в сервисе биллинга', 'обработчики платежей снова падают в сервисе биллинга')).toBeLessThan(0.5);
    expect(topicShift('rename getUserName helper everywhere', 'getUserName helper still fails everywhere')).toBeLessThan(0.7);
  });

  it('ignores stopwords and returns 0 when there is too little text', () => {
    expect(topicShift('the and for with', 'для и на с')).toBe(0);
    expect(topicShift('implement the exporter for invoices in the billing module', 'ok commit')).toBe(0);
    expect(topicShift('', '')).toBe(0);
  });
});
