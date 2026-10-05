// Pure text helpers: ANSI-aware width, padding, wrapping, numbers, bars, sparklines.

import { homedir } from 'node:os';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// East Asian wide / fullwidth / emoji count as 2 cells, combining and joiner marks as 0.
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if ((cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function visWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

export function padR(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - visWidth(s)));
}

export function padL(s: string, w: number): string {
  return ' '.repeat(Math.max(0, w - visWidth(s))) + s;
}

// Left text and right text on one line of the given width; right side wins when they collide.
export function spread(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visWidth(left) - visWidth(right));
  return left + ' '.repeat(gap) + right;
}

// Plain strings only (no ANSI).
export function truncate(s: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (visWidth(s) <= max) return s;
  const budget = max - visWidth(ellipsis);
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

// Keep the tail (useful for paths).
export function truncateStart(s: string, max: number): string {
  if (visWidth(s) <= max) return s;
  const chars = [...s];
  let out = '';
  let w = 1;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]!.codePointAt(0)!);
    if (w + cw > max) break;
    out = chars[i] + out;
    w += cw;
  }
  return '…' + out;
}

// User text -> a single safe line: no control chars, no emoji (their width is terminal-dependent).
export function sanitizeInline(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FFFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Greedy word wrap on visible width; words longer than the width are hard-broken. Input must be plain text.
export function wrap(text: string, width: number): string[] {
  return wrapWith(text, () => width);
}

// Same, with a per-line width (line index -> width), for text that flows beside a right-hand column.
export function wrapWith(text: string, widthFor: (line: number) => number): string[] {
  const out: string[] = [];
  let line = '';
  const push = (): void => {
    if (line) out.push(line);
    line = '';
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (visWidth(w) > widthFor(out.length)) {
      if (line) push();
      const head = truncate(w, widthFor(out.length), '');
      if (!head) break;
      out.push(head);
      w = w.slice(head.length);
    }
    if (!line) line = w;
    else if (visWidth(line) + 1 + visWidth(w) <= widthFor(out.length)) line += ' ' + w;
    else {
      push();
      line = w;
    }
  }
  push();
  return out.length ? out : [''];
}

// Wrap pre-styled parts without ever splitting a part.
export function wrapParts(parts: string[], sep: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const p of parts) {
    if (!line) line = p;
    else if (visWidth(line) + visWidth(sep) + visWidth(p) <= width) line += sep + p;
    else {
      out.push(line);
      line = p;
    }
  }
  if (line) out.push(line);
  return out;
}

export function groupThousands(n: number, sep: string): string {
  const s = Math.round(Math.abs(n)).toString();
  const out = s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return n < 0 ? '−' + out : out;
}

export function money(usd: number): string {
  const rounded = Math.round(Math.abs(usd) * 100) / 100;
  const [i = '0', f = '00'] = rounded.toFixed(2).split('.');
  const body = '$' + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
  return usd < 0 && rounded > 0 ? '−' + body : body;
}

// Per-step amounts are tiny: keep three decimals below one dollar.
export function money3(usd: number): string {
  if (Math.abs(usd) >= 1) return money(usd);
  const body = '$' + Math.abs(usd).toFixed(3);
  return usd < 0 ? '−' + body : body;
}

// 0.813 -> "81%"; tiny non-zero shares -> "<1%".
export function pct(frac: number): string {
  if (!Number.isFinite(frac)) return '–';
  const p = frac * 100;
  if (p > 0 && p < 0.5) return '<1%';
  return Math.round(p) + '%';
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

export function bytes(n: number, kb: string, mb: string): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' ' + mb;
  return (n / 1024).toFixed(1) + ' ' + kb;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function resolveWidth(columns: number | undefined): number {
  return clamp(Math.floor(columns && columns > 0 ? columns : 80), 64, 100);
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// Smooth horizontal bar of at most `width` cells (not padded). Non-zero values always show at least one eighth.
export function bar(frac: number, width: number): string {
  if (!(frac > 0) || width <= 0) return '';
  const eighths = Math.max(1, Math.min(width * 8, Math.round(frac * width * 8)));
  return '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// One char per value; zero maps to the lowest tick marked by ` ` -> caller can style zero separately.
export function sparkChar(v: number, max: number): string {
  if (!(v > 0) || !(max > 0)) return SPARKS[0]!;
  return SPARKS[Math.min(7, Math.max(0, Math.ceil((v / max) * 8) - 1))]!;
}

// Sum neighbouring values so that the series fits into `width` columns.
export function downsample(values: number[], width: number): number[] {
  if (values.length <= width) return values;
  const out: number[] = [];
  for (let i = 0; i < width; i++) {
    const a = Math.floor((i * values.length) / width);
    const b = Math.floor(((i + 1) * values.length) / width);
    let s = 0;
    for (let j = a; j < Math.max(b, a + 1); j++) s += values[j] ?? 0;
    out.push(s);
  }
  return out;
}

// Largest-remainder allocation of `cells` among shares; every non-zero share gets at least one cell.
export function allocate(shares: number[], cells: number): number[] {
  const total = shares.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || cells <= 0) return shares.map(() => 0);
  const raw = shares.map((s) => (Math.max(0, s) / total) * cells);
  const out = raw.map((x, i) => (shares[i]! > 0 ? Math.max(1, Math.floor(x)) : 0));
  let diff = cells - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (let k = 0; diff !== 0 && k < 1000; k++) {
    const e = order[k % order.length]!;
    if (diff > 0) {
      out[e.i]! += 1;
      diff--;
    } else if (out[e.i]! > 1) {
      out[e.i]! -= 1;
      diff++;
    }
  }
  return out;
}

export function shortModel(id: string): string {
  return id
    .replace(/^.*claude-/, '')
    .replace(/\[.*?\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/(\d)-(\d)/g, '$1.$2');
}

// "/Users/me/Projects/x" -> "~/Projects/x"; paths outside the home directory stay as they are.
export function tildify(path: string, home: string = homedir()): string {
  const h = home.replace(/[\\/]+$/, '');
  if (!h) return path;
  if (path === h) return '~';
  return path.startsWith(h + '/') || path.startsWith(h + '\\') ? '~' + path.slice(h.length) : path;
}

// Local wall-clock "YYYY-MM-DD HH:MM" of an ISO timestamp (the report is read by the person who ran it).
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
