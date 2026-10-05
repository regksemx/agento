import { tierOf, tierRank, type Tier } from './pricing.ts';

// How aggressively agento acts. `quality` and `off` never touch anything.
export type Mode = 'balanced' | 'eco' | 'quality' | 'off';
export const MODES: readonly Mode[] = ['balanced', 'eco', 'quality', 'off'];

export function parseMode(v: unknown): Mode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v) ? (v as Mode) : 'balanced';
}

export interface SpawnInput {
  subagentType: string;
  requestedModel?: string;
  prompt: string;
  parentModel: string;
  mode: Mode;
  // What the running task's first steps said (core/trajectory.ts): a ceiling for the subagent's tier, or null.
  trajectory?: { spawnTier: Tier | null } | null;
}

// `model` undefined = leave the spawn untouched.
export interface SpawnDecision {
  model?: string;
  reason: string;
}

// Letters, digits and underscore count as word characters; \b does not know Cyrillic.
const W = '(?<![\\p{L}\\p{N}_])';
const END = '(?![\\p{L}\\p{N}_])';
// English words match whole, with common inflections; Russian stems match as prefixes.
const kw = (en: string[], ru: string[]): RegExp =>
  new RegExp(`${W}(?:(?:${en.join('|')})(?:e|es|ed|d|ing|s|ion|ation|ment)?${END}${ru.length ? `|(?:${ru.join('|')})` : ''})`, 'iu');

// Reading, searching, summarizing (ru/en).
const SEARCH_RE = kw(
  ['find', 'search', 'grep', 'locat', 'look\\s+(?:for|up|through|at)', 'explor', 'investigat', 'scan', 'list\\s+(?:all|the|every)',
    'read', 'summari[sz]', 'summary', 'overview', 'where\\s+(?:is|are|does|do)', '(?:which|what)\\s+files?', 'collect', 'gather'],
  ['найд', 'найти', 'поищ', 'ищи', 'искать', 'поиск', 'прочита', 'прочти', 'читай', 'изуч', 'исследу', 'обзор',
    'сводк', 'суммар', 'резюм', 'перечисл', 'собер', 'собрать', 'где\\s+(?:находится|используется|определен|определён|лежит)', 'какие\\s+файлы'],
);

// Writing code: such a task is not a cheap read.
const IMPLEMENT_RE = kw(
  ['implement', 'writ(?:e|ing|ten|es)?', 'add(?:ing)?', 'fix', 'refactor', 'creat', 'build', 'change', 'modif(?:y|ies|ied|ying)', 'updat', 'rewrit', 'migrat', 'edit', 'patch', 'renam', 'delet', 'remov'],
  ['реализу', 'реализовать', 'напиши', 'написать', 'добав', 'исправ', 'почини', 'починить', 'созда', 'измени', 'изменить', 'обнови', 'обновить',
    'перепиши', 'рефактор', 'мигрир', 'переимену', 'удали', 'допиши', 'внедри'],
);

// Review, security, audits: these deserve the parent's model.
const SENSITIVE_RE = kw(
  ['review', 'security', 'vulnerabilit(?:y|ies)', 'vulnerable', 'audit', 'exploit', 'threat', 'cve'],
  ['ревью', 'рецензи', 'безопасн', 'уязвим', 'аудит', 'проверь\\s+код', 'код-ревью'],
);
const SENSITIVE_TYPE_RE = /review|secur|audit|plan/i;

export function isSearchPrompt(prompt: string): boolean {
  return SEARCH_RE.test(prompt);
}
export function isImplementPrompt(prompt: string): boolean {
  return IMPLEMENT_RE.test(prompt);
}
export function isSensitivePrompt(prompt: string): boolean {
  return SENSITIVE_RE.test(prompt);
}

const keep = (reason: string): SpawnDecision => ({ reason });

// Spec §5.5. Subagents own their cache, so choosing their model never costs a rewrite of the parent's.
export function decideSpawnModel(i: SpawnInput): SpawnDecision {
  if (i.requestedModel) return keep('explicit-model');
  if (i.mode === 'quality' || i.mode === 'off') return keep(`mode-${i.mode}`);
  const type = (i.subagentType ?? '').trim();
  const lower = type.toLowerCase();
  if (lower === 'fork') return keep('fork-inherits-cache');
  if (lower.startsWith('agento-') || lower.startsWith('agento:')) return keep('agento-agent');
  if (SENSITIVE_TYPE_RE.test(type) || isSensitivePrompt(i.prompt)) return keep('plan-review-security');

  let target: Tier | null = null;
  let why = '';
  if (lower === 'explore') {
    target = 'haiku';
    why = 'explore-agent';
  } else if (!isImplementPrompt(i.prompt) && isSearchPrompt(i.prompt)) {
    target = 'haiku';
    why = 'search-read-summarize';
  } else if (lower === 'general-purpose' && isImplementPrompt(i.prompt)) {
    target = 'sonnet';
    why = 'implementation';
  }
  // The trajectory only ever lowers: a rule's target above its ceiling comes down to it, and a spawn no rule covers
  // takes it. Never above the parent (below), and the sensitive types were left alone above.
  const ceiling = i.trajectory?.spawnTier ?? null;
  if (ceiling) {
    if (!target) {
      target = ceiling;
      why = 'trajectory';
    } else if (tierRank(target) > tierRank(ceiling)) {
      target = ceiling;
      why += '+trajectory';
    }
  }
  if (!target) return keep('no-rule');

  // P3: never above the parent, and no point when the parent is already that cheap.
  const parentTier = tierOf(i.parentModel);
  if (!parentTier) return keep('unknown-parent-model');
  if (tierRank(target) >= tierRank(parentTier)) return keep('not-cheaper-than-parent');
  return { model: target, reason: why };
}
