// Renders the synthetic sample report as a terminal-style SVG for the README.
// Usage: node scripts/readme-svg.ts [ru|en] > docs/assets/audit.svg
// Uses cli/test/sample-report.ts only — never real transcripts.

import { renderTerminal } from '../cli/src/report/index.ts';
import { makeSampleReport } from '../cli/test/sample-report.ts';

const lang = (process.argv[2] === 'ru' ? 'ru' : 'en') as 'ru' | 'en';
const WIDTH = 84;
const MAX_LINES = Number(process.env.SVG_LINES ?? 64);

const ansi = renderTerminal(makeSampleReport(lang), { color: 'truecolor', width: WIDTH });

const BG = '#1e1d1b';
const FG = '#e8e6e3';
const DIM_ALPHA = 0.55;
const CHAR_W = 8.4;
const LINE_H = 18;
const PAD_X = 24;
const TOP = 52;

const XTERM_16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

function xterm256(n: number): string {
  if (n < 16) return XTERM_16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgb(v, v, v);
  }
  const i = n - 16;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return rgb(c(Math.floor(i / 36)), c(Math.floor(i / 6) % 6), c(i % 6));
}

function rgb(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

interface Style { fg: string; bold: boolean; dim: boolean }
interface Run { text: string; style: Style }

function parseLine(line: string, start: Style): { runs: Run[]; end: Style } {
  const runs: Run[] = [];
  let style = { ...start };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index), style: { ...style } });
    last = re.lastIndex;
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) style = { fg: FG, bold: false, dim: false };
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 22) { style.bold = false; style.dim = false; }
      else if (c === 39) style.fg = FG;
      else if (c >= 30 && c <= 37) style.fg = XTERM_16[c - 30]!;
      else if (c >= 90 && c <= 97) style.fg = XTERM_16[c - 90 + 8]!;
      else if (c === 38 && codes[i + 1] === 2) { style.fg = rgb(codes[i + 2]!, codes[i + 3]!, codes[i + 4]!); i += 4; }
      else if (c === 38 && codes[i + 1] === 5) { style.fg = xterm256(codes[i + 2]!); i += 2; }
    }
  }
  if (last < line.length) runs.push({ text: line.slice(last), style: { ...style } });
  return { runs, end: style };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const all = ansi.split('\n');
// SVG_RANGE="start:end" picks a slice of lines (negative values count from the end).
const [from, to] = (process.env.SVG_RANGE ?? `0:${MAX_LINES}`).split(':').map((v) => (v === '' ? undefined : Number(v)));
const lines = all.slice(from, to);

const BLOCKS: Record<string, number> = { '█': 1, '▉': 7 / 8, '▊': 6 / 8, '▋': 5 / 8, '▌': 4 / 8, '▍': 3 / 8, '▎': 2 / 8, '▏': 1 / 8 };
const SPARKS: Record<string, number> = { '▁': 1 / 8, '▂': 2 / 8, '▃': 3 / 8, '▄': 4 / 8, '▅': 5 / 8, '▆': 6 / 8, '▇': 7 / 8 };
const isGraphic = (c: string) => BLOCKS[c] !== undefined || SPARKS[c] !== undefined;

let style: Style = { fg: FG, bold: false, dim: false };
const body: string[] = [];
lines.forEach((line, i) => {
  const parsed = parseLine(line, style);
  style = parsed.end;
  const y = TOP + i * LINE_H;
  let col = 0;
  for (const r of parsed.runs) {
    const chars = [...r.text];
    // Bars become rectangles: font glyphs leave hairline seams between block characters.
    let j = 0;
    while (j < chars.length) {
      const spark = SPARKS[chars[j]!];
      if (spark !== undefined) {
        const op = r.style.dim ? ` fill-opacity="${DIM_ALPHA}"` : '';
        const hgt = 14 * spark;
        body.push(`<rect x="${(PAD_X + (col + j) * CHAR_W).toFixed(1)}" y="${(y + 2 - hgt).toFixed(1)}" width="${(CHAR_W - 1).toFixed(1)}" height="${hgt.toFixed(1)}" rx="1" fill="${r.style.fg}"${op}/>`);
        j++;
        continue;
      }
      const frac = BLOCKS[chars[j]!];
      if (frac !== undefined) {
        let width = 0;
        const x0 = col + j;
        while (j < chars.length && BLOCKS[chars[j]!] !== undefined) width += BLOCKS[chars[j++]!]!;
        const op = r.style.dim ? ` fill-opacity="${DIM_ALPHA}"` : '';
        body.push(`<rect x="${(PAD_X + x0 * CHAR_W).toFixed(1)}" y="${y - 12}" width="${(width * CHAR_W).toFixed(1)}" height="14" rx="1.5" fill="${r.style.fg}"${op}/>`);
        continue;
      }
      let k = j;
      while (k < chars.length && !isGraphic(chars[k]!)) k++;
      const text = chars.slice(j, k).join('');
      if (text.trim().length > 0) {
        // textLength pins the run to its columns whatever monospace font the viewer has.
        const attrs = [`x="${(PAD_X + (col + j) * CHAR_W).toFixed(1)}"`, `y="${y}"`, `fill="${r.style.fg}"`, `textLength="${((k - j) * CHAR_W).toFixed(1)}"`, 'lengthAdjust="spacingAndGlyphs"'];
        if (r.style.bold) attrs.push('font-weight="700"');
        if (r.style.dim) attrs.push(`fill-opacity="${DIM_ALPHA}"`);
        body.push(`<text ${attrs.join(' ')} xml:space="preserve">${esc(text)}</text>`);
      }
      j = k;
    }
    col += chars.length;
  }
});

const w = Math.round(PAD_X * 2 + WIDTH * CHAR_W);
const h = TOP + lines.length * LINE_H + 16;
const dots = ['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<circle cx="${22 + i * 20}" cy="20" r="6" fill="${c}"/>`).join('');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" rx="10" fill="${BG}"/>
${dots}
<text x="${w / 2}" y="25" text-anchor="middle" fill="${FG}" fill-opacity="0.5" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">npx agento-cc audit</text>
<g font-family="ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace" font-size="14">
${body.join('\n')}
</g>
</svg>
`);
