// Fills the numbered figures of the GitHub Pages site from site/data/*.json, so the pages need no JavaScript.
// Usage: node scripts/site-figures.ts   (rewrites the <!-- fig:id --> ... <!-- /fig:id --> blocks in site/**/*.html)
// Charts are plain inline SVG in the site's ink palette (classes from site/style.css); every chart is followed by
// its data table. Aggregates only: no prompts, no project names, no paths.

import { readFileSync, writeFileSync } from 'node:fs';

type Lang = 'en' | 'ru';
const root = new URL('../site/', import.meta.url);
const bench = JSON.parse(readFileSync(new URL('data/bench.json', root), 'utf8'));
const train = JSON.parse(readFileSync(new URL('data/training.json', root), 'utf8'));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NB = ' ';
const group = (n: number, l: Lang) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, l === 'ru' ? NB : ',');
const dec = (v: number, d: number, l: Lang) => (l === 'ru' ? v.toFixed(d).replace('.', ',') : v.toFixed(d));
const usd = (v: number, l: Lang, d = 0) => (d ? '$' + dec(v, d, l) : '$' + group(v, l));
const usdS = (v: number, l: Lang) => (v < 10 ? usd(v, l, 2) : usd(v, l)); // small amounts keep their cents
const pct = (v: number) => `${Math.round(v * 100)}%`;
const f1 = (v: number) => +v.toFixed(2);

const T = {
  en: { data: 'Data table', steps: (n: number) => `${n} steps`, calls: 'calls', events: 'events' },
  ru: { data: 'Таблица данных', steps: (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'шаг' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'шага' : 'шагов'}`, calls: 'вызовов', events: 'событий' },
};

function table(head: string[], rows: Array<Array<string | number>>, right: number[] = []): string {
  const th = head.map((h, i) => `<th${right.includes(i) ? ' class="r"' : ''}>${esc(h)}</th>`).join('');
  const tb = rows.map((r) => '<tr>' + r.map((c, i) => `<td${right.includes(i) ? ' class="r"' : ''}>${esc(String(c))}</td>`).join('') + '</tr>').join('\n');
  return `<table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tb}\n</tbody>\n</table>`;
}
const details = (l: Lang, inner: string) => `<details class="data"><summary>${T[l].data}</summary>\n${inner}\n</details>`;

// One horizontal bar: an SVG stretched to its cell; `line` draws a red-pencil mark at that value.
function barSvg(v: number, max: number, cls: string, line?: number): string {
  const w = Math.max(0, (v / max) * 100);
  const mark = line !== undefined ? `<line x1="${f1((line / max) * 100)}" x2="${f1((line / max) * 100)}" y1="0" y2="10" class="sm" vector-effect="non-scaling-stroke"/>` : '';
  return `<svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect width="${f1(w)}" height="10" class="${cls}"/>${mark}</svg>`;
}

interface Row { label: string; value: number; text: string; cls?: string }
function hbars(rows: Row[], aria: string, opts: { max?: number; wide?: boolean } = {}): string {
  const max = opts.max ?? Math.max(...rows.map((r) => r.value));
  const body = rows.map((r) => `<div class="bar"><span class="l">${esc(r.label)}</span>${barSvg(r.value, max, r.cls ?? 'f1')}<span class="v">${esc(r.text)}</span></div>`).join('\n');
  return `<div class="bars${opts.wide ? ' wide-l' : ''}" role="img" aria-label="${esc(aria)}">\n${body}\n</div>`;
}

// Grouped bars: a label line, then one bar per series.
interface Group { label: string; bars: Array<{ name: string; value: number; text: string; cls: string; line?: number }> }
function groups(gs: Group[], aria: string, max: number): string {
  const body = gs.map((g) => `<div class="grp"><div class="gl">${esc(g.label)}</div>\n` +
    g.bars.map((b) => `<div class="bar"><span class="l">${esc(b.name)}</span>${barSvg(b.value, max, b.cls, b.line)}<span class="v">${esc(b.text)}</span></div>`).join('\n') + '</div>').join('\n');
  return `<div class="bars grouped" role="img" aria-label="${esc(aria)}">\n${body}\n</div>`;
}

// A 100% stacked bar with a key, as in figure 1 of the home page.
function stack(segs: Array<{ label: string; v: number; cls: string; text: string }>, aria: string, keyFirst = false): string {
  const total = segs.reduce((a, s) => a + s.v, 0);
  const vis = segs.filter((s) => s.v / total >= 0.004);
  const gap = 1.5;
  const free = 400 - gap * (vis.length - 1);
  let x = 0;
  const rects = vis.map((s) => { const w = (s.v / total) * free; const r = `<rect x="${f1(x)}" y="0" width="${f1(w)}" height="28" class="${s.cls}"/>`; x += w + gap; return r; }).join('');
  const svg = `<svg class="stack" viewBox="0 0 400 28" preserveAspectRatio="none" role="img" aria-label="${esc(aria)}">${rects}</svg>`;
  const key = '<table class="key">\n' + segs.map((s) => `<tr><td><i class="${s.v / total >= 0.004 ? s.cls : 'f0'}"></i>${esc(s.label)}</td><td class="r">${esc(s.text)}</td><td class="r">${pct(s.v / total)}</td></tr>`).join('\n') + '\n</table>';
  return keyFirst ? key + '\n' + svg : svg + '\n' + key;
}

// ---------- figures from bench.json ----------

const B = bench.buckets;
const bucketSegs = (l: Lang) => {
  const n = l === 'ru' ? ['чтение кэша', 'запись в кэш', 'вывод (output)', 'ввод без кэша'] : ['cache reads', 'cache writes', 'output', 'uncached input'];
  return [
    { label: n[0]!, v: B.cacheRead, cls: 'f1', text: usd(B.cacheRead, l) },
    { label: n[1]!, v: B.cacheWrite, cls: 'f2', text: usd(B.cacheWrite, l) },
    { label: n[2]!, v: B.output, cls: 'f3', text: usd(B.output, l) },
    { label: n[3]!, v: B.input, cls: 'f4', text: usd(B.input, l, 2) },
  ];
};
const ariaBuckets = (l: Lang) => {
  const t = B.cacheRead + B.cacheWrite + B.output + B.input;
  return l === 'ru'
    ? `Полоса с накоплением: чтение кэша ${pct(B.cacheRead / t)}, запись в кэш ${pct(B.cacheWrite / t)}, вывод ${pct(B.output / t)}`
    : `Stacked bar: cache reads ${pct(B.cacheRead / t)}, cache writes ${pct(B.cacheWrite / t)}, output ${pct(B.output / t)}`;
};

const figs: Record<string, (l: Lang) => string> = {
  buckets: (l) => stack(bucketSegs(l), ariaBuckets(l)),

  family: (l) => {
    const rows = bench.byFamily.map((f: any) => ({ label: f.family, value: f.usd, text: usdS(f.usd, l) }));
    const tot = bench.byFamily.reduce((a: number, f: any) => a + f.usd, 0);
    return hbars(rows, l === 'ru' ? 'Расход по семействам моделей' : 'Spend by model family') + '\n' +
      details(l, table(l === 'ru' ? ['Семейство', 'Расход', 'Доля'] : ['Family', 'Spend', 'Share'], bench.byFamily.map((f: any) => [f.family, usd(f.usd, l, 2), pct(f.usd / tot)]), [1, 2]));
  },

  effort: (l) => {
    const name = (e: string) => (e === 'unknown' ? (l === 'ru' ? 'не указан' : 'unknown') : e);
    const tot = bench.effortMix.reduce((a: number, f: any) => a + f.usd, 0);
    return hbars(bench.effortMix.map((e: any) => ({ label: name(e.effort), value: e.usd, text: usdS(e.usd, l) })), l === 'ru' ? 'Расход по уровню effort' : 'Spend by effort') + '\n' +
      details(l, table(['effort', l === 'ru' ? 'Расход' : 'Spend', l === 'ru' ? 'Доля' : 'Share'], bench.effortMix.map((e: any) => [name(e.effort), usd(e.usd, l, 2), pct(e.usd / tot)]), [1, 2]));
  },

  weeks: (l) => {
    const mon = l === 'ru' ? ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'] : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const lab = (w: string) => { const [, m, d] = w.split('-').map(Number); return l === 'ru' ? `${d}${NB}${mon[m! - 1]}` : `${mon[m! - 1]}${NB}${d}`; };
    const max = Math.max(...bench.byWeek.map((w: any) => w.usd));
    const last = bench.byWeek.length - 1;
    const cols = bench.byWeek.map((w: any, i: number) => {
      const partial = i === 0 || i === last;
      const h = f1((w.usd / max) * 100);
      return `<div class="col"><span class="v">${usd(w.usd, l)}</span><svg viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true" style="height:${f1(h * 1.8)}px"><rect width="10" height="10" class="${partial ? 'f3' : 'f1'}"/></svg></div>`;
    }).join('\n');
    const labs = bench.byWeek.map((w: any) => `<span>${lab(w.week)}</span>`).join('');
    return `<div class="cols" role="img" aria-label="${l === 'ru' ? 'Расход по неделям' : 'Spend by week'}">\n${cols}\n</div>\n<div class="cols-l" aria-hidden="true">${labs}</div>\n` +
      details(l, table(l === 'ru' ? ['Неделя с', 'Расход'] : ['Week of', 'Spend'], bench.byWeek.map((w: any, i: number) => [w.week + (i === 0 || i === last ? (l === 'ru' ? ' (неполная)' : ' (partial)') : ''), usd(w.usd, l, 2)]), [1]));
  },

  subagents: (l) => {
    const ms = bench.mainVsSub;
    const head = stack([
      { label: l === 'ru' ? 'основной поток' : 'main thread', v: ms.main, cls: 'f1', text: usd(ms.main, l) },
      { label: l === 'ru' ? 'субагенты' : 'subagents', v: ms.subagents, cls: 'f2', text: usd(ms.subagents, l) },
    ], l === 'ru' ? `Основной поток ${pct(ms.main / (ms.main + ms.subagents))}, субагенты ${pct(ms.subagents / (ms.main + ms.subagents))}` : `Main thread ${pct(ms.main / (ms.main + ms.subagents))}, subagents ${pct(ms.subagents / (ms.main + ms.subagents))}`);
    const rows = bench.subagentTypes.map((s: any) => ({ label: s.type, value: s.usd, text: usdS(s.usd, l), cls: 'f2' }));
    return head + '\n<div class="sub-h">' + (l === 'ru' ? 'Субагенты по типу' : 'Subagents by type') + '</div>\n' +
      hbars(rows, l === 'ru' ? 'Расход субагентов по типу' : 'Subagent spend by type', { wide: true }) + '\n' +
      details(l, table(l === 'ru' ? ['Тип субагента', 'Расход', 'Вызовов'] : ['Subagent type', 'Spend', 'Calls'], bench.subagentTypes.map((s: any) => [s.type, usd(s.usd, l, 2), group(s.calls, l)]), [1, 2]));
  },

  losses: (l) => {
    const name: Record<string, [string, string]> = {
      ttl: ['pause outlived the cache', 'пауза дольше жизни кэша'],
      'model-switch': ['model switch', 'смена модели'],
      compaction: ['compaction', 'сжатие контекста'],
      'effort-change': ['effort change', 'смена effort'],
      unknown: ['cause not visible', 'причина не видна'],
    };
    const nm = (c: string) => name[c]![l === 'ru' ? 1 : 0];
    const ls = [...bench.cache.losses].sort((a: any, b: any) => b.usd - a.usd);
    return hbars(ls.map((c: any) => ({ label: nm(c.cause), value: c.usd, text: usdS(c.usd, l), cls: c.cause === 'ttl' ? 'f1' : 'f2' })), l === 'ru' ? 'Стоимость промахов кэша по причине' : 'Cost of cache misses by cause', { wide: true }) + '\n' +
      details(l, table(l === 'ru' ? ['Причина', 'Событий', 'Оценка стоимости'] : ['Cause', 'Events', 'Estimated cost'], ls.map((c: any) => [nm(c.cause), group(c.events, l), usd(c.usd, l, 2)]), [1, 2]));
  },

  gaps: (l) => {
    const name: Record<string, [string, string]> = { '<1m': ['under 1 min', 'меньше минуты'], '1–5m': ['1 to 5 min', '1–5 мин'], '5–15m': ['5 to 15 min', '5–15 мин'], '15–60m': ['15 to 60 min', '15–60 мин'], '>60m': ['over an hour', 'больше часа'] };
    const nm = (k: string) => name[k]![l === 'ru' ? 1 : 0];
    const tot = bench.gapHistogram.reduce((a: number, g: any) => a + g.count, 0);
    return hbars(bench.gapHistogram.map((g: any, i: number) => ({ label: nm(g.label), value: g.count, text: group(g.count, l), cls: i >= 2 ? 'f1' : 'f3' })), l === 'ru' ? 'Паузы между запросами' : 'Gaps between requests', { wide: true }) + '\n' +
      details(l, table(l === 'ru' ? ['Пауза', 'Запросов', 'Доля'] : ['Gap', 'Requests', 'Share'], bench.gapHistogram.map((g: any) => [nm(g.label), group(g.count, l), (g.count / tot * 100).toFixed(1).replace('.', l === 'ru' ? ',' : '.') + '%']), [1, 2]));
  },

  breakeven: (l) => {
    const pairs: string[] = [];
    for (const s of bench.switchSim) { const k = `${s.from} → ${s.to}`; if (!pairs.includes(k)) pairs.push(k); }
    const sizes = [...new Set(bench.switchSim.map((s: any) => s.prefixTokens))] as number[];
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    const gs: Group[] = pairs.map((p) => ({
      label: p,
      bars: sizes.map((sz, i) => {
        const s = bench.switchSim.find((x: any) => `${x.from} → ${x.to}` === p && x.prefixTokens === sz);
        return { name: (l === 'ru' ? 'префикс ' : 'prefix ') + k(sz), value: s.breakEvenSteps, text: T[l].steps(s.breakEvenSteps), cls: i === 0 ? 'f1' : 'f2' };
      }),
    }));
    const max = Math.max(...bench.switchSim.map((s: any) => s.breakEvenSteps));
    return groups(gs, l === 'ru' ? 'Через сколько шагов окупится смена модели посреди задачи' : 'Steps until a mid-task model switch pays off', max) + '\n' +
      details(l, table(l === 'ru' ? ['Переход', 'Префикс', 'Штраф', 'Экономия за шаг', 'Окупится'] : ['Switch', 'Prefix', 'Penalty', 'Gain per step', 'Break-even'],
        bench.switchSim.map((s: any) => [`${s.from} → ${s.to}`, k(s.prefixTokens), usd(s.penalty, l, 2), usd(s.savingPerStep, l, 4), T[l].steps(s.breakEvenSteps)]), [1, 2, 3, 4]));
  },

  matrix: (l) => {
    const j = bench.opusJudge;
    const ran = ['opus', 'fable', 'sonnet'];
    const need = ['haiku', 'sonnet', 'opus'];
    const max = Math.max(...j.matrix.map((m: any) => m.n));
    const cell = (r: string, n: string) => {
      const v = j.matrix.find((m: any) => m.ran === r && m.needed === n)?.n ?? 0;
      const q = v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 4));
      const cheaper = (r === 'opus' || r === 'fable') && (n === 'haiku' || n === 'sonnet');
      return `<td class="r q${q}${cheaper ? ' cheap' : ''}">${group(v, l)}</td>`;
    };
    const total = (r: string) => j.matrix.filter((m: any) => m.ran === r).reduce((a: number, m: any) => a + m.n, 0);
    const head = l === 'ru' ? ['Шла на ↓ · хватило бы →', ...need, 'всего'] : ['Ran on ↓ · needed →', ...need, 'total'];
    return `<table class="matrix">\n<thead><tr>${head.map((h, i) => `<th${i ? ' class="r"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>\n<tbody>\n` +
      ran.map((r) => `<tr><th scope="row">${r}</th>${need.map((n) => cell(r, n)).join('')}<td class="r">${group(total(r), l)}</td></tr>`).join('\n') + '\n</tbody>\n</table>';
  },

  judges: (l) => {
    const J = bench.judges;
    const rows = l === 'ru'
      ? [['Opus против моей ручной разметки', J.opusVsHuman], ['Qwen против моей ручной разметки', J.qwenVsHuman], ['Opus против Qwen', J.opusVsQwen], ['Qwen на шагах SWE-bench', J.publicSweQwen]]
      : [['Opus vs my hand labels', J.opusVsHuman], ['Qwen vs my hand labels', J.qwenVsHuman], ['Opus vs Qwen', J.opusVsQwen], ['Qwen on SWE-bench steps', J.publicSweQwen]];
    const names = l === 'ru' ? ['слишком дёшево', 'совпало', 'дороже нужного'] : ['too cheap', 'agreed', 'too expensive'];
    const seg = (r: any) => {
      const parts = [{ v: r.under, c: 'f1' }, { v: r.accuracy, c: 'f3' }, { v: r.over, c: 'f2' }];
      let x = 0;
      return `<svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">${parts.map((p) => { const s = `<rect x="${f1(x)}" width="${f1(p.v * 100)}" height="10" class="${p.c}"/>`; x += p.v * 100; return s; }).join('')}</svg>`;
    };
    const key = `<p class="legend"><span><i class="f1"></i>${names[0]}</span><span><i class="f3"></i>${names[1]}</span><span><i class="f2"></i>${names[2]}</span></p>`;
    const body = rows.map(([lab, r]: any) => `<div class="bar"><span class="l">${esc(lab)} <span class="n">n${NB}=${NB}${r.n}</span></span>${seg(r)}<span class="v">${pct(r.under)}</span></div>`).join('\n');
    return key + `\n<div class="bars wide-l" role="img" aria-label="${l === 'ru' ? 'Насколько судьи ошибаются в сторону дешёвой модели' : 'How often each judge picks too cheap a model'}">\n${body}\n</div>\n` +
      details(l, table(l === 'ru' ? ['Сравнение', 'n', 'Совпало', 'Слишком дёшево', 'Дороже нужного'] : ['Comparison', 'n', 'Agreed', 'Too cheap', 'Too expensive'],
        rows.map(([lab, r]: any) => [lab, r.n, pct(r.accuracy), pct(r.under), pct(r.over)]), [1, 2, 3, 4]));
  },

  // ---------- figures from training.json ----------

  heads: (l) => {
    const H = train.testHeads;
    const st = l === 'ru'
      ? { tier: 'не действует сам', effort: 'не используется', plan_first: 'используется', delegate_explore: 'используется' }
      : { tier: 'never acts', effort: 'not used', plan_first: 'in use', delegate_explore: 'in use' };
    const keys = ['tier', 'effort', 'plan_first', 'delegate_explore'] as const;
    return hbars(keys.map((k) => ({ label: k, value: H[k].accuracy, text: pct(H[k].accuracy), cls: k === 'plan_first' || k === 'delegate_explore' ? 'f1' : 'f3' })), l === 'ru' ? 'Точность голов ученика на отложенных задачах' : 'Student head accuracy on held-out tasks', { max: 1, wide: true }) + '\n' +
      details(l, table(l === 'ru' ? ['Голова', 'Точность', 'macro-F1', 'ECE', 'В плагине'] : ['Head', 'Accuracy', 'macro-F1', 'ECE', 'In the plugin'],
        keys.map((k) => [k, pct(H[k].accuracy), dec(H[k].macro_f1, 2, l), dec(H[k].ece, 3, l), st[k]]), [1, 2, 3]));
  },

  policies: (l) => {
    const name: Record<string, [string, string]> = {
      'student, every task': ['trained student, every task', 'обученный ученик, на каждой задаче'],
      'always sonnet': ['always Sonnet', 'всегда Sonnet'],
      'rules v1': ['built-in rules (shipped)', 'встроенные правила (в плагине)'],
      'L0 (sees the finished trajectory)': ['L0, sees the finished trajectory', 'L0, видит готовую траекторию'],
      'always opus': ['always Opus', 'всегда Opus'],
    };
    const nm = (p: string) => name[p]?.[l === 'ru' ? 1 : 0] ?? p;
    const gs: Group[] = train.tierPolicies.map((p: any) => ({
      label: nm(p.policy),
      bars: [
        { name: l === 'ru' ? 'точность' : 'accuracy', value: p.accuracy, text: pct(p.accuracy), cls: 'f3' },
        { name: l === 'ru' ? 'слишком дёшево' : 'too cheap', value: p.under, text: p.under > 0 && p.under < 0.1 ? dec(p.under * 100, 1, l) + '%' : pct(p.under), cls: 'f1', line: 0.05 },
      ],
    }));
    return groups(gs, l === 'ru' ? 'Точность и доля слишком дешёвых выборов у разных политик' : 'Accuracy and too-cheap rate of each policy', 1) + '\n' +
      details(l, table(l === 'ru' ? ['Политика', 'Точность', 'Слишком дёшево', 'Дороже нужного'] : ['Policy', 'Accuracy', 'Too cheap', 'Too expensive'],
        train.tierPolicies.map((p: any) => [nm(p.policy), pct(p.accuracy), dec(p.under * 100, 1, l) + '%', dec(p.over * 100, 1, l) + '%']), [1, 2, 3]));
  },

  // The short table on the home page.
  'policy-table': (l) => {
    const order = ['student, every task', 'always sonnet', 'rules v1', 'always opus'];
    const name: Record<string, [string, string]> = {
      'student, every task': ['Trained student, every task', 'Обученный ученик, на каждой задаче'],
      'always sonnet': ['Always Sonnet', 'Всегда Sonnet'],
      'rules v1': ['Built-in rules (shipped today)', 'Встроенные правила (работают сейчас)'],
      'always opus': ['Always Opus', 'Всегда Opus'],
    };
    const ps = order.map((o) => train.tierPolicies.find((p: any) => p.policy === o));
    const th = l === 'ru' ? ['Политика на 87 отложенных задачах', 'Точность', 'Слишком дёшево'] : ['Policy on 87 held-out tasks', 'Accuracy', 'Too cheap'];
    return `<table>\n<thead><tr><th>${th[0]}</th><th class="r">${th[1]}</th><th class="r">${th[2]}</th></tr></thead>\n<tbody>\n` +
      ps.map((p: any) => `<tr${p.policy === 'rules v1' ? ' class="hl"' : ''}><td>${name[p.policy]![l === 'ru' ? 1 : 0]}</td><td class="r">${pct(p.accuracy)}</td><td class="r">${pct(p.under)}</td></tr>`).join('\n') + '\n</tbody>\n</table>';
  },

  student: (l) => {
    const s = train.student;
    const ms = (v: number) => `${dec(v, 1, l)}${NB}${l === 'ru' ? 'мс' : 'ms'}`;
    const rows = l === 'ru'
      ? [['Модель', s.model.replace('intfloat/', '')], ['Параметров', `${s.params_m}${NB}млн`], ['Размер', `${s.size_mb}${NB}МБ`],
        ['p50, длина 128, CPU машины обучения', ms(s.p50_ms_seq128)], ['p50, длина 256, CPU машины обучения', ms(s.p50_ms_seq256)],
        ['p50 установленного демона, Mac на Apple silicon', `≈${NB}6${NB}мс`], ['Совпадение ONNX и PyTorch', dec(s.onnx_parity, 2, l)], ['Версия int8', 'отброшена (совпадение 0,888 < 0,98)']]
      : [['Model', s.model.replace('intfloat/', '')], ['Parameters', `${s.params_m}M`], ['Size', `${s.size_mb}${NB}MB`],
        ['p50, length 128, training box CPU', ms(s.p50_ms_seq128)], ['p50, length 256, training box CPU', ms(s.p50_ms_seq256)],
        ['p50 of the installed daemon, Apple-silicon Mac', `≈${NB}6${NB}ms`], ['ONNX vs PyTorch agreement', s.onnx_parity.toFixed(2)], ['int8 version', 'discarded (agreement 0.888 < 0.98)']];
    return '<table class="spec">\n<tbody>\n' + rows.map(([a, b]) => `<tr><td>${esc(a!)}</td><td class="r">${esc(b!)}</td></tr>`).join('\n') + '\n</tbody>\n</table>';
  },

  // ---------- drawn figures (two widths: the narrow one keeps the type legible on a phone) ----------

  context: (l) => [660, 358].map((W) => contextSvg(W, l)).join('\n'),
  switchcost: (l) => [660, 358].map((W) => switchSvg(W, l)).join('\n') + '\n' + switchTable(l),
  handoff: (l) => [660, 358].map((W) => handoffSvg(W, l)).join('\n'),
};

const txt = (x: number, y: number, s: string, cls = 't1', size = 13, extra = '') => `<text x="${f1(x)}" y="${f1(y)}" font-size="${size}" class="${cls}"${extra}>${esc(s)}</text>`;
const svgOpen = (W: number, H: number, aria: string) => `<svg class="${W > 400 ? 'v-wide' : 'v-narrow'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">`;

// Context size over two tasks: picking a model at a clean point is free, switching mid-task is not.
function contextSvg(W: number, l: Lang): string {
  const ru = l === 'ru';
  const sx = (x: number) => 30 + ((x - 40) * (W - 40)) / 610;
  const p = (pts: Array<[number, number]>) => pts.map(([x, y]) => `${f1(sx(x))} ${y}`);
  const a = p([[40, 210], [120, 190], [200, 130], [270, 100], [380, 62], [410, 58]]);
  const b = p([[412, 206], [470, 196], [560, 160], [650, 140]]);
  const narrow = W < 400;
  const aria = ru
    ? 'Размер контекста в двух задачах. Выбор модели в начале задачи и после /clear бесплатен; смена при контексте 100k посреди задачи стоит 23 цента.'
    : 'Context size over two tasks. Choosing a model at the start of a task or after /clear is free; switching at 100k context mid-task costs 23 cents.';
  const X = sx(270);
  return svgOpen(W, 280, aria) +
    `<line x1="${f1(sx(40))}" y1="220" x2="${f1(sx(650))}" y2="220" class="s1"/>` +
    `<line x1="${f1(sx(40))}" y1="40" x2="${f1(sx(40))}" y2="220" class="sr"/>` +
    `<line x1="${f1(sx(40))}" y1="100" x2="${f1(sx(650))}" y2="100" class="sr" stroke-dasharray="2 4"/>` +
    txt(sx(40) + 4, 94, ru ? '100k токенов' : '100k tokens', 't3', 12.5) +
    `<path d="M${a[0]} C ${a[1]}, ${a[2]}, ${a[3]} S ${a[4]}, ${a[5]} L ${f1(sx(410))} 220 L ${f1(sx(40))} 220 Z" class="fa"/>` +
    `<path d="M${a[0]} C ${a[1]}, ${a[2]}, ${a[3]} S ${a[4]}, ${a[5]}" class="s1 w2" fill="none"/>` +
    `<path d="M${b[0]} C ${b[1]}, ${b[2]}, ${b[3]} L ${f1(sx(650))} 220 L ${f1(sx(412))} 220 Z" class="fa"/>` +
    `<path d="M${b[0]} C ${b[1]}, ${b[2]}, ${b[3]}" class="s1 w2" fill="none"/>` +
    `<line x1="${f1(sx(411))}" y1="58" x2="${f1(sx(411))}" y2="206" class="s1" stroke-dasharray="3 3"/>` +
    `<circle cx="${f1(sx(40))}" cy="210" r="6" class="fp s1 w2"/><circle cx="${f1(sx(412))}" cy="206" r="6" class="fp s1 w2"/>` +
    `<g class="sm w24"><line x1="${f1(X - 7)}" y1="93" x2="${f1(X + 7)}" y2="107"/><line x1="${f1(X + 7)}" y1="93" x2="${f1(X - 7)}" y2="107"/></g>` +
    txt(sx(40) + (narrow ? 2 : 16), 250, ru ? 'начало задачи' : 'task starts', 't1 b', 14) +
    txt(sx(40) + (narrow ? 2 : 16), 266, ru ? 'выбор модели: $0' : 'pick a model: $0', 't2', 13) +
    txt(sx(412) + 8, 250, ru ? '/clear, новая задача' : '/clear, next task', 't1 b', 14) +
    txt(sx(412) + 8, 266, ru ? 'выбор заново: $0' : 'pick again: $0', 't2', 13) +
    txt(narrow ? sx(40) + 6 : 150, 26, ru ? 'смена здесь: +$0,23' : 'switch here: +$0.23', 'tm b', 14) +
    txt(narrow ? sx(40) + 6 : 150, 43, ru ? 'окупится через ~10 шагов' : 'pays off after ~10 steps', 't2', 13) +
    `<line x1="${narrow ? f1(sx(40) + 60) : 230}" y1="49" x2="${f1(X - 8)}" y2="90" class="sm"/>` +
    txt(sx(narrow ? 190 : 300), 214, ru ? 'шаги →' : 'steps →', 't3', 12.5) + '</svg>';
}

// Cumulative cost after the decision point: stay on Opus 5.5 vs switch to Sonnet 5.5 at a 100k cached prefix.
const STEP = { opus: 0.065, sonnet: 0.0425, penalty: 0.23 };
function switchSvg(W: number, l: Lang): string {
  const ru = l === 'ru';
  const L = 46, R = W - (W < 400 ? 12 : 120), Tp = 20, Bt = 210, N = 20, Ymax = 1.4;
  const x = (n: number) => L + (n / N) * (R - L);
  const y = (v: number) => Bt - (v / Ymax) * (Bt - Tp);
  const be = STEP.penalty / (STEP.opus - STEP.sonnet);
  const out: string[] = [svgOpen(W, 262, ru
    ? 'Накопленная стоимость после смены модели при префиксе 100k: остаться на Opus или перейти на Sonnet. Линии пересекаются примерно на десятом шаге.'
    : 'Cumulative cost after a mid-task switch at a 100k prefix: stay on Opus or switch to Sonnet. The lines cross at about ten steps.')];
  for (const v of [0, 0.5, 1]) {
    out.push(`<line x1="${L}" x2="${R}" y1="${f1(y(v))}" y2="${f1(y(v))}" class="${v === 0 ? 's1' : 'sr'}"${v ? ' stroke-dasharray="2 4"' : ''}/>`);
    out.push(txt(L - 6, y(v) + 4, ru ? `$${v.toFixed(2).replace('.', ',')}` : `$${v.toFixed(2)}`, 't3', 12, ' text-anchor="end"'));
  }
  for (const n of [0, 5, 10, 15, 20]) out.push(txt(x(n), Bt + 18, String(n), 't3', 12, ' text-anchor="middle"'));
  out.push(txt(R, Bt + 36, ru ? 'шагов после смены' : 'steps after the switch', 't3', 12, ' text-anchor="end"'));
  out.push(`<line x1="${x(0)}" y1="${f1(y(0))}" x2="${x(N)}" y2="${f1(y(STEP.opus * N))}" class="s1 w2"/>`);
  out.push(`<line x1="${x(0)}" y1="${f1(y(STEP.penalty))}" x2="${x(N)}" y2="${f1(y(STEP.penalty + STEP.sonnet * N))}" class="s1 w2" stroke-dasharray="6 4"/>`);
  out.push(`<circle cx="${x(0)}" cy="${f1(y(STEP.penalty))}" r="4" class="fp s1 w2"/>`);
  const narrow = W < 400;
  if (narrow) {
    // A legend instead of labels on the lines: there is no room beside them on a phone.
    const lx = L + 6;
    out.push(`<line x1="${lx}" x2="${lx + 26}" y1="26" y2="26" class="s1 w2"/>` + txt(lx + 34, 30, ru ? 'остаться на Opus' : 'stay on Opus', 't1 b', 13));
    out.push(`<line x1="${lx}" x2="${lx + 26}" y1="46" y2="46" class="s1 w2" stroke-dasharray="6 4"/>` + txt(lx + 34, 50, ru ? 'перейти на Sonnet' : 'switch to Sonnet', 't1 b', 13));
    out.push(`<circle cx="${lx + 13}" cy="66" r="4" class="fp s1 w2"/>` + txt(lx + 34, 70, ru ? '+$0,23 за перезапись кэша' : '+$0.23 to rewrite the cache', 't2', 12.5));
  } else {
    out.push(txt(x(N) + 8, y(STEP.opus * N) + 4, ru ? 'остаться на Opus' : 'stay on Opus', 't1 b', 13));
    out.push(txt(x(N) + 8, y(STEP.penalty + STEP.sonnet * N) + 4, ru ? 'перейти на Sonnet' : 'switch to Sonnet', 't1 b', 13));
    out.push(txt(x(0) + 2, y(0.66), ru ? '+$0,23 за перезапись кэша' : '+$0.23 to rewrite the cache', 't2', 12.5));
    out.push(`<line x1="${x(0) + 6}" y1="${f1(y(0.66) + 5)}" x2="${x(0) + 2}" y2="${f1(y(STEP.penalty) - 6)}" class="sr"/>`);
  }
  const cx = x(be), cy = y(STEP.opus * be);
  out.push(`<g class="sm w24"><line x1="${f1(cx - 6)}" y1="${f1(cy - 6)}" x2="${f1(cx + 6)}" y2="${f1(cy + 6)}"/><line x1="${f1(cx + 6)}" y1="${f1(cy - 6)}" x2="${f1(cx - 6)}" y2="${f1(cy + 6)}"/></g>`);
  out.push(txt(cx + 10, cy + 28, ru ? 'окупилось: ~10 шагов' : 'break-even: ~10 steps', 'tm b', 13));
  out.push('</svg>');
  return out.join('');
}
function switchTable(l: Lang): string {
  const rows = [0, 5, 10, 15, 20].map((n) => [n, usd(STEP.opus * n, l, 2), usd(STEP.penalty + STEP.sonnet * n, l, 2)]);
  return details(l, table(l === 'ru' ? ['Шагов после смены', 'Остаться на Opus', 'Перейти на Sonnet'] : ['Steps after the switch', 'Stay on Opus', 'Switch to Sonnet'], rows, [1, 2]));
}

// Plan on Opus, then /clear and write the code on Sonnet from the saved plan.
function handoffSvg(W: number, l: Lang): string {
  const ru = l === 'ru';
  const narrow = W < 400;
  const L = 30, R = W - 10, Bt = 200;
  const sx = (t: number) => L + t * (R - L); // t in 0..1
  const y = (k: number) => Bt - (k / 100) * 150; // k = thousands of tokens
  const split = 0.5;
  const a = `M${f1(sx(0))} ${f1(y(12))} C ${f1(sx(0.15))} ${f1(y(30))}, ${f1(sx(0.3))} ${f1(y(70))}, ${f1(sx(split))} ${f1(y(90))}`;
  const b = `M${f1(sx(split + 0.005))} ${f1(y(8))} C ${f1(sx(0.7))} ${f1(y(14))}, ${f1(sx(0.85))} ${f1(y(28))}, ${f1(sx(1))} ${f1(y(40))}`;
  const aria = ru
    ? 'Размер контекста: план обсуждается на Opus и растёт до 90k; после одобрения плана /clear, и Sonnet начинает с ~8k.'
    : 'Context size: the plan is discussed on Opus and grows to 90k; after approval, /clear, and Sonnet starts from about 8k.';
  return svgOpen(W, 262, aria) +
    `<line x1="${L}" y1="${Bt}" x2="${R}" y2="${Bt}" class="s1"/>` +
    `<line x1="${L}" y1="${f1(y(100))}" x2="${L}" y2="${Bt}" class="sr"/>` +
    `<path d="${a} L ${f1(sx(split))} ${Bt} L ${f1(sx(0))} ${Bt} Z" class="fa"/><path d="${a}" class="s1 w2" fill="none"/>` +
    `<path d="${b} L ${f1(sx(1))} ${Bt} L ${f1(sx(split + 0.005))} ${Bt} Z" class="fa"/><path d="${b}" class="s1 w2" fill="none"/>` +
    `<line x1="${f1(sx(split))}" y1="${f1(y(90))}" x2="${f1(sx(split))}" y2="${Bt}" class="s1" stroke-dasharray="3 3"/>` +
    `<circle cx="${f1(sx(split + 0.005))}" cy="${f1(y(8))}" r="5" class="fp s1 w2"/>` +
    txt(sx(0.03), y(100) + 4, ru ? 'план на Opus: ~90k' : 'plan on Opus: ~90k', 't1 b', 13.5) +
    txt(sx(split) + 10, y(60), ru ? 'план одобрен, /clear' : 'plan approved, /clear', 't1 b', 13.5) +
    txt(sx(split) + 10, y(60) + 17, ru ? 'перезаписывать нечего' : 'nothing to rewrite', 't2', 12.5) +
    txt(narrow ? sx(split) + 10 : sx(0.62), Bt + 22, ru ? 'код на Sonnet' : 'code on Sonnet', 't1 b', 13.5) +
    txt(narrow ? sx(split) + 10 : sx(0.62), Bt + 39, ru ? 'с ~8k: план и нужные файлы' : 'from ~8k: the plan and its files', 't2', 12.5) +
    txt(sx(0.03), Bt + 22, ru ? 'обсуждение' : 'discussion', 't1 b', 13.5) +
    txt(sx(0.03), Bt + 39, ru ? 'файлы, вопросы, варианты' : 'files, questions, options', 't2', 12.5) +
    '</svg>';
}

// ---------- fill the pages ----------

const pages = ['index.html', 'how-it-works.html', 'benchmarks.html', 'ru/index.html', 'ru/how-it-works.html', 'ru/benchmarks.html'];
let n = 0;
for (const p of pages) {
  const url = new URL(p, root);
  const l: Lang = p.startsWith('ru/') ? 'ru' : 'en';
  const src = readFileSync(url, 'utf8');
  const out = src.replace(/<!-- fig:([\w-]+) -->[\s\S]*?<!-- \/fig:\1 -->/g, (_m, id: string) => {
    const f = figs[id];
    if (!f) throw new Error(`${p}: unknown figure "${id}"`);
    n++;
    return `<!-- fig:${id} -->\n${f(l)}\n<!-- /fig:${id} -->`;
  });
  if (out !== src) writeFileSync(url, out);
}
console.log(`site-figures: filled ${n} figures in ${pages.length} pages`);
