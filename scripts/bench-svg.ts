// Renders the headline numbers of site/data/bench.json as a terminal-style SVG for the README.
// Usage: node scripts/bench-svg.ts [en|ru] > docs/assets/bench.svg
// Reads aggregates only (the author's own 30 days and judge comparisons); no project names, no prompts.

import { readFileSync } from 'node:fs';

const lang = process.argv[2] === 'ru' ? 'ru' : 'en';
const d = JSON.parse(readFileSync(new URL('../site/data/bench.json', import.meta.url), 'utf8'));

const W = 754;
const BG = '#1e1d1b';
const FG = '#e8e6e3';
const DIM = '#a39e95';
const C = { read: '#d06a48', write: '#5b97d6', output: '#b08a2e', input: '#a383cc', quiet: '#4a4741', under: '#d06a48', agree: '#5b97d6', over: '#b08a2e' };
const FONT = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";

const L = lang === 'ru'
  ? {
      title: 'agento · 30 дней автора',
      head: 'Куда ушли деньги',
      sub: (usd: string) => `${usd} в API-эквиваленте · один пользователь на подписке · не бенчмарк`,
      read: 'чтение кэша', write: 'запись кэша', output: 'output', input: 'ввод',
      judge: 'Судья Opus по законченным задачам (мнение, не повторный прогон)',
      cheaper: (n: number, of: number, p: string) => `${n} из ${of} задач на Opus/Fable справились бы дешевле: ${p}`,
      vsHuman: (u: string, n: number) => `против ручной разметки автора судья недооценивает: ${u} (n = ${n})`,
      agree: 'совпало', under: 'недооценка', over: 'переоценка',
    }
  : {
      title: "agento · the author's 30 days",
      head: 'Where the money went',
      sub: (usd: string) => `${usd} API-equivalent · one subscription user · not a benchmark`,
      read: 'cache read', write: 'cache write', output: 'output', input: 'input',
      judge: 'Opus as a judge of finished tasks (opinion, not a replay)',
      cheaper: (n: number, of: number, p: string) => `${n} of ${of} Opus/Fable tasks would have been fine cheaper: ${p}`,
      vsHuman: (u: string, n: number) => `against the author's hand labels the judge under-routes ${u} (n = ${n})`,
      agree: 'agree', under: 'under-routing', over: 'over-routing',
    };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (v: number) => `${Math.round(v * 100)}%`;
const usd = (v: number) => '$' + Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'ru' ? ' ' : ',');
const t = (x: number, y: number, s: string, o: { fill?: string; size?: number; bold?: boolean; anchor?: string; op?: number } = {}) =>
  `<text x="${x}" y="${y}" fill="${o.fill ?? FG}" font-size="${o.size ?? 14}"${o.bold ? ' font-weight="700"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.op ? ` fill-opacity="${o.op}"` : ''} xml:space="preserve">${esc(s)}</text>`;

// A 100% bar with 2px gaps; the outer ends rounded.
function bar(x: number, y: number, w: number, h: number, segs: Array<{ v: number; c: string; label?: string }>): string {
  const total = segs.reduce((a, s) => a + s.v, 0);
  const vis = segs.filter((s) => (s.v / total) * w >= 1);
  const free = w - (vis.length - 1) * 2;
  let cx = x;
  const out: string[] = [`<clipPath id="cp${y}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/></clipPath><g clip-path="url(#cp${y})">`];
  for (const s of vis) {
    const sw = (s.v / total) * free;
    out.push(`<rect x="${cx.toFixed(1)}" y="${y}" width="${sw.toFixed(1)}" height="${h}" fill="${s.c}"/>`);
    if (s.label && sw > s.label.length * 8.4 + 12) out.push(t(cx + 8, y + h / 2 + 5, s.label, { fill: '#fff', size: 13, bold: true }));
    cx += sw + 2;
  }
  out.push('</g>');
  return out.join('');
}

const b = d.buckets;
const total = b.cacheWrite + b.cacheRead + b.output + b.input;
const m = d.opusJudge.matrix as Array<{ ran: string; needed: string; n: number }>;
let exp = 0;
let cheaper = 0;
for (const e of m) if (e.ran === 'opus' || e.ran === 'fable') { exp += e.n; if (e.needed === 'haiku' || e.needed === 'sonnet') cheaper += e.n; }
const j = d.judges.opusVsHuman;

const P = 24;
const BW = W - 2 * P;
const rows: string[] = [];
let y = 66;
rows.push(t(P, y, L.head, { bold: true, fill: '#d97757' }));
rows.push(t(P, y + 20, L.sub(usd(total)), { fill: DIM, size: 13 }));
y += 36;
rows.push(bar(P, y, BW, 24, [
  { v: b.cacheRead, c: C.read, label: pct(b.cacheRead / total) },
  { v: b.cacheWrite, c: C.write, label: pct(b.cacheWrite / total) },
  { v: b.output, c: C.output, label: pct(b.output / total) },
  { v: b.input, c: C.input },
]));
y += 46;
let lx = P;
for (const [name, c, v] of [[L.read, C.read, b.cacheRead], [L.write, C.write, b.cacheWrite], [L.output, C.output, b.output]] as Array<[string, string, number]>) {
  rows.push(`<rect x="${lx}" y="${y - 10}" width="10" height="10" rx="2" fill="${c}"/>`);
  const s = `${name} ${usd(v)}`;
  rows.push(t(lx + 16, y, s, { size: 13 }));
  lx += 16 + s.length * 7.9 + 22;
}
y += 40;
rows.push(t(P, y, L.judge, { bold: true, fill: '#d97757' }));
y += 22;
rows.push(t(P, y, L.cheaper(cheaper, exp, pct(cheaper / exp)), { size: 13 }));
y += 14;
rows.push(bar(P, y, BW, 14, [{ v: cheaper, c: C.read }, { v: exp - cheaper, c: C.quiet }]));
y += 36;
rows.push(t(P, y, L.vsHuman(pct(j.under), j.n), { size: 13 }));
y += 14;
rows.push(bar(P, y, BW, 14, [{ v: j.accuracy, c: C.agree }, { v: j.under, c: C.under }, { v: j.over, c: C.over }]));
y += 32;
lx = P;
for (const [name, c] of [[L.agree, C.agree], [L.under, C.under], [L.over, C.over]] as Array<[string, string]>) {
  rows.push(`<rect x="${lx}" y="${y - 10}" width="10" height="10" rx="2" fill="${c}"/>`);
  rows.push(t(lx + 16, y, name, { size: 13, fill: DIM }));
  lx += 16 + name.length * 7.9 + 22;
}
const H = y + 22;
const dots = ['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<circle cx="${22 + i * 20}" cy="20" r="6" fill="${c}"/>`).join('');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="10" fill="${BG}"/>
${dots}
<text x="${W / 2}" y="25" text-anchor="middle" fill="${FG}" fill-opacity="0.5" font-family="${FONT}" font-size="12">${esc(L.title)}</text>
<g font-family="${FONT}">
${rows.join('\n')}
</g>
</svg>
`);
