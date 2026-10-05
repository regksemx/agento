// Secret scrubbing for dataset text. Principle: never leak, prefer over-scrubbing.
// Pure and synchronous. `scrub` returns the cleaned text and how many replacements each rule made.

export type ScrubKind =
  | 'private-key'
  | 'url-credentials'
  | 'jwt'
  | 'api-key'
  | 'bearer'
  | 'assignment'
  | 'email'
  | 'home-path'
  | 'high-entropy';

export const SCRUB_KINDS: readonly ScrubKind[] = [
  'private-key',
  'url-credentials',
  'jwt',
  'api-key',
  'bearer',
  'assignment',
  'email',
  'home-path',
  'high-entropy',
];

export type ScrubHits = Record<ScrubKind, number>;

export interface ScrubResult {
  text: string;
  hits: ScrubHits;
}

export const SECRET = '[SECRET]';
export const EMAIL = '[EMAIL]';

// Entropy thresholds (bits per char, Shannon) for the last-resort detector.
// A random 32-char base64 string scores about 4.5, a random 32-char hex string about 3.7; identifiers and prose stay below.
export const ENTROPY = { minLength: 32, mixed: 4.0, hex: 3.2, slug: 4.3 } as const;

export function emptyHits(): ScrubHits {
  return Object.fromEntries(SCRUB_KINDS.map((k) => [k, 0])) as ScrubHits;
}

export function addHits(into: ScrubHits, from: ScrubHits): void {
  for (const k of SCRUB_KINDS) into[k] += from[k];
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...s].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// ───────────────────────── rules ─────────────────────────

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

// scheme://user:password@host (the password may contain "@" and ":"; it ends at the first "/" or whitespace).
const URL_CREDS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]+@/gi;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

const API_KEY_RES: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, // OpenAI and look-alikes (sk-proj-…)
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key id
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, // Google
  /(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g,
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
];

const BEARER_RE = /\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

// key = value, where the key contains a secret-ish word. Groups: 1 key (with optional quote), 2 separator, 3 quote, 4 value.
const SECRET_WORDS = '(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|authorization)';
const ASSIGN_RE = new RegExp(`((?:--)?[\\w.-]*${SECRET_WORDS}[\\w.-]*["']?)(\\s*(?::=|=>|[:=])\\s*|\\s+(?=--|[A-Za-z0-9]))(["'\`]?)([^\\s"'\`,;)}\\]]+)`, 'gi');
// Quoted values may contain spaces: handled separately so that `password = "my pass phrase"` is cleaned whole.
const ASSIGN_QUOTED_RE = new RegExp(`((?:--)?[\\w.-]*${SECRET_WORDS}[\\w.-]*["']?\\s*(?::=|=>|[:=])\\s*)(["'\`])((?:(?!\\2)[^\\n]){1,200})\\2`, 'gi');

const NOT_A_VALUE = new Set([
  'string', 'str', 'number', 'int', 'bool', 'boolean', 'null', 'none', 'nil', 'undefined', 'true', 'false', 'required', 'optional',
  'await', 'async', 'this', 'self', 'new', 'function', 'return', 'env', 'your', 'the', 'a', 'an', 'is', 'of', 'to', 'in', 'for', 'from',
  'and', 'or', 'not', 'any', 'object', 'unknown', 'record', 'secret', 'token', 'password', 'value', 'here', 'xxx', 'xxxx',
]);

function isPlaceholderValue(v: string): boolean {
  const l = v.toLowerCase();
  if (v.includes('[SECRET') || v.includes('[EMAIL')) return true; // already cleaned by an earlier rule
  if (NOT_A_VALUE.has(l)) return true;
  // references, not values: $VAR, ${VAR}, <placeholder>, {{ tpl }}, process.env.X, os.environ[...]
  return /^(?:\$|<|\{\{|%|process\.env|os\.environ|env\.|import\.meta)/.test(v);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

const HOME_UNIX_RE = /(?<![\w.~-])\/(?:Users|home)\/[^/\s"'`:;,)\]}>|\\]+/g;
const HOME_WIN_RE = /(?<![\w])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`:;,)\]}>|]+/gi;

const ENTROPY_RE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

function looksSecret(tok: string): boolean {
  const core = tok.replace(/=+$/, '');
  if (core.length < ENTROPY.minLength) return false;
  if (UUID_RE.test(core) || GIT_SHA_RE.test(core)) return false;
  if (!/\d/.test(core)) return false; // identifiers, words, paths: no digits at all
  if (/^[0-9a-fA-F]+$/.test(core)) return shannonEntropy(core) >= ENTROPY.hex;
  const h = shannonEntropy(core);
  // lowercase path / slug with separators (src/very/long/path-name-123): only clearly random ones count
  if (!/[A-Z]/.test(core) && /[/_-]/.test(core)) return h >= ENTROPY.slug;
  return h >= ENTROPY.mixed;
}

// ───────────────────────── api ─────────────────────────

export function scrub(input: string): ScrubResult {
  const hits = emptyHits();
  let text = input;
  const apply = (kind: ScrubKind, re: RegExp, replace: string | ((...m: string[]) => string | null)): void => {
    text = text.replace(re, (...args: unknown[]) => {
      const m = args.slice(0, -2) as string[]; // drop offset and whole string (no named groups used)
      const out = typeof replace === 'string' ? replace : replace(...m);
      if (out === null) return m[0] as string;
      hits[kind] += 1;
      return out;
    });
  };

  apply('private-key', PRIVATE_KEY_RE, SECRET);
  apply('url-credentials', URL_CREDS_RE, (_m, scheme) => `${scheme}${SECRET}@`);
  apply('jwt', JWT_RE, SECRET);
  for (const re of API_KEY_RES) apply('api-key', re, SECRET);
  apply('bearer', BEARER_RE, (_m, word, ws) => `${word}${ws}${SECRET}`);
  apply('assignment', ASSIGN_QUOTED_RE, (_m, head, q) => `${head}${q}${SECRET}${q}`);
  apply('assignment', ASSIGN_RE, (m, key, sep, q, value) => {
    if (isPlaceholderValue(value as string)) return null;
    // `max_tokens: 4096`: a count, not a credential
    if (/tokens["']?$/i.test(key as string) && /^\d+$/.test(value as string)) return null;
    // a bare-space separator ("--token abc") only counts for CLI flags
    if (!/[:=]/.test(sep as string) && !/^--/.test(key as string)) return null;
    void m;
    return `${key}${sep}${q}${SECRET}`;
  });
  apply('email', EMAIL_RE, EMAIL);
  apply('home-path', HOME_UNIX_RE, '~');
  apply('home-path', HOME_WIN_RE, '~');
  apply('high-entropy', ENTROPY_RE, (m) => (looksSecret(m as string) ? SECRET : null));
  return { text, hits };
}

export function scrubText(input: string): string {
  return scrub(input).text;
}
