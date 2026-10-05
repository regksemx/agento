// Task boundaries, prompt features and the v1 rule classifier. Pure TypeScript: no imports, no Node APIs.

export type TaskTier = 'haiku' | 'sonnet' | 'opus';
export type TaskEffort = 'low' | 'medium' | 'high';

export interface TaskFeatures {
  promptChars: number;
  promptLang: 'ru' | 'en' | 'other';
  hasCodeBlock: boolean;
  mentionsFiles: number;
  keywords: { heavy: number; light: number; plan: number };
  isSessionStart: boolean;
  contextTokens: number;
}

export interface TaskVerdict {
  tier: TaskTier;
  effort: TaskEffort;
  confidence: number;
  reasons: string[];
  // Who decided: `rules-v1` (the local rules; also what an absent value means) or `brain:<model_run_id>`.
  classifier?: string;
  // Why a trained classifier's answer was not used (`timeout`, `error`, `invalid`, `abstain`, `rules-v1`, `unavailable`).
  fallback?: string;
  // Only a trained classifier answers these: plan before coding; hand the exploring to a cheap subagent.
  planFirst?: boolean;
  delegateExplore?: boolean;
  latencyMs?: number;
}

export const RULES_ID = 'rules-v1';

// How the task began, in the training data's words: a new session, after /clear (or a compaction), after the cache went cold.
export type StartKind = 'session' | 'clear' | 'cold';

export interface TaskContext {
  contextTokens: number;
  isSessionStart: boolean;
  startKind?: StartKind;
  // Languages of the repository, when cheaply known.
  languages?: readonly string[];
}

export interface TaskClassifier {
  classify(prompt: string, ctx: TaskContext): Promise<TaskVerdict>;
}

// ───────────────────────── keyword dictionaries ─────────────────────────
// A string matches a word that STARTS with it (a stem); a trailing `$` demands the exact word.
// A RegExp is tested against the lowercased, ё-folded prompt. Entries are counted once each.

type Entry = string | RegExp;

export const HEAVY_WORDS: readonly Entry[] = [
  // ru
  'архитектур',
  'спроектир',
  'проектирован',
  'распредел',
  'миграци',
  'мигрир',
  'производительн',
  'масштабир',
  'масштабируем',
  'многопоточ',
  'конкурентн',
  'дедлок',
  'взаимоблокир',
  'гонк',
  'утечк памят',
  'безопасност',
  'уязвимост',
  'микросервис',
  'консенсус',
  'идемпотентн',
  /(?:от)?рефактор\S*\s+(?:\S+\s+){0,2}?(?:модул|систем|подсистем|архитектур|сервис|кодов\S* баз)/u,
  // en
  'architect',
  'design$',
  'migrat',
  'distribut',
  'race$',
  'deadlock',
  'concurren',
  'multithread',
  'performance',
  'scalab',
  'microservice',
  'vulnerab',
  'consensus',
  'idempoten',
  'memory leak',
  'from scratch',
  /\brefactor\w*\s+(?:\S+\s+){0,3}?(?:module|system|subsystem|architecture|codebase|service)/u,
];

export const LIGHT_WORDS: readonly Entry[] = [
  // ru
  'опечатк',
  'переимен',
  'обнови верси',
  'обновить верси',
  'поправь текст',
  'исправь текст',
  'readme',
  'комментари',
  'форматир',
  'отформатир',
  'докстринг',
  'отступ',
  /добав\S*\s+(?:\S+\s+){0,2}?лог/u,
  // en
  'typo',
  'rename',
  'bump',
  'prettier',
  'lint',
  'docstring',
  'changelog',
  'comment$',
  'comments$',
  'format$',
  /(?:update|upgrade)\s+(?:the\s+)?version/u,
  /add\s+(?:a\s+|the\s+)?(?:\S+\s+){0,2}?log(?:ging|s)?\b/u,
  /fix\s+(?:the\s+)?(?:text|wording)/u,
];

export const PLAN_WORDS: readonly Entry[] = [
  // ru
  'как лучше',
  'давай обсудим',
  'обсудим',
  'обсуд',
  'план',
  'подход$',
  'подхода$',
  'подходы$',
  'подходов$',
  'вариант',
  'продумай',
  'стратеги',
  'плюсы и минусы',
  'стоит ли',
  // en
  'plan$',
  'planning$',
  'approach',
  'options$',
  'brainstorm',
  'trade-off',
  'tradeoff',
  'pros and cons',
  'best way',
  'how should we',
  "let's discuss",
  'strategy',
];

function compile(entries: readonly Entry[]): RegExp[] {
  return entries.map((e) => {
    if (typeof e !== 'string') return e;
    const exact = e.endsWith('$');
    const stem = (exact ? e.slice(0, -1) : e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${stem}${exact ? '(?![\\p{L}\\p{N}_])' : ''}`, 'u');
  });
}

const HEAVY_RE = compile(HEAVY_WORDS);
const LIGHT_RE = compile(LIGHT_WORDS);
const PLAN_RE = compile(PLAN_WORDS);

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function countHits(res: readonly RegExp[], text: string): number {
  let n = 0;
  for (const re of res) if (re.test(text)) n += 1;
  return n;
}

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const FILE_RE = /(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|md|json|ya?ml|toml|sh|sql|css|html|lock)\b/g;

export function extractFeatures(prompt: string, ctx: TaskContext): TaskFeatures {
  const prose = normalize(prompt.replace(FENCE_RE, ' '));
  let cyr = 0;
  let lat = 0;
  for (const ch of prose) {
    if (/[а-я]/.test(ch)) cyr += 1;
    else if (/[a-z]/.test(ch)) lat += 1;
  }
  const promptLang = cyr + lat === 0 ? 'other' : cyr / (cyr + lat) > 0.3 ? 'ru' : 'en';
  const files = new Set((prompt.replace(FENCE_RE, ' ').match(FILE_RE) ?? []).map((f) => f.toLowerCase()));
  return {
    promptChars: prompt.length,
    promptLang,
    hasCodeBlock: /```/.test(prompt),
    mentionsFiles: files.size,
    keywords: { heavy: countHits(HEAVY_RE, prose), light: countHits(LIGHT_RE, prose), plan: countHits(PLAN_RE, prose) },
    isSessionStart: ctx.isSessionStart,
    contextTokens: ctx.contextTokens,
  };
}

// v1 rules: never answers 'haiku' — the cheapest tier is only recommended by later classifiers.
export function classifyRules(f: TaskFeatures): TaskVerdict {
  const { heavy, light, plan } = f.keywords;
  if (light >= 1 && heavy === 0 && f.promptChars < 400) {
    return { tier: 'sonnet', effort: 'medium', confidence: 0.7, reasons: [`light keywords: ${light}`, `short prompt: ${f.promptChars} chars`] };
  }
  if (heavy >= 1 || plan >= 1) {
    const reasons: string[] = [];
    if (heavy >= 1) reasons.push(`heavy keywords: ${heavy}`);
    if (plan >= 1) reasons.push(`planning keywords: ${plan}`);
    return { tier: 'opus', effort: 'high', confidence: 0.6, reasons };
  }
  return { tier: 'sonnet', effort: 'high', confidence: 0.4, reasons: ['no strong signal'] };
}

export const rulesClassifier: TaskClassifier = {
  classify: (prompt, ctx) => Promise.resolve(classifyRules(extractFeatures(prompt, ctx))),
};

// ───────────────────────── task start (spec §4.4) ─────────────────────────

export type TaskStartReason = 'first-prompt' | 'compact' | 'clear' | 'idle' | 'explicit';

export interface TaskStartInput {
  isFirstPrompt: boolean;
  markerSinceLastPrompt: 'compact' | 'clear' | null;
  msSinceLastMainCall: number | null; // null: no main call yet
  ttlMs: number;
  explicitNew: boolean; // `/agento new`
}

// A task start is a "clean point": the main cache is empty or cold, so a model switch is free.
export function isTaskStart(i: TaskStartInput): TaskStartReason | null {
  if (i.isFirstPrompt) return 'first-prompt';
  if (i.markerSinceLastPrompt) return i.markerSinceLastPrompt;
  if (i.msSinceLastMainCall !== null && i.msSinceLastMainCall > i.ttlMs) return 'idle';
  if (i.explicitNew) return 'explicit';
  return null;
}

// ───────────────────────── lexical topic shift ─────────────────────────

const STOPWORDS = new Set(
  (
    'the and for with this that these those from into onto about have has had are was were been being you your not but can could should would will ' +
    'please just then than also all any some its it\'s let lets now here there what when where which how why use using make sure need want like ' +
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь ' +
    'когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам сказал ведь там потом себя ничего ей может они тут где есть ' +
    'надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь ' +
    'этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти ' +
    'нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно ' +
    'всю между пожалуйста нужно сделай давай надо'
  ).split(/\s+/),
);

const MIN_TOPIC_TOKENS = 3;

// Word stems: camelCase and snake_case split, ё folded, English plurals dropped, then cut to 5 chars
// so "обработчика"/"обработчики" and "handler"/"handlers" collapse together.
function topicTokens(text: string): Set<string> {
  const words = text
    .replace(FENCE_RE, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(/[\p{L}\p{N}]+/gu);
  const out = new Set<string>();
  for (const w of words ?? []) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w.slice(0, 5));
  }
  return out;
}

// 1 − Jaccard of the two prompts' stem sets: 0 = same topic, 1 = nothing in common.
// With too little text on either side there is no evidence of a shift, so the result is 0.
export function topicShift(prevPrompt: string, prompt: string): number {
  const a = topicTokens(prevPrompt);
  const b = topicTokens(prompt);
  if (a.size < MIN_TOPIC_TOKENS || b.size < MIN_TOPIC_TOKENS) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return 1 - inter / (a.size + b.size - inter);
}
