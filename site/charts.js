// Benchmarks page: draws every chart as inline SVG from data/bench.json (and data/training.json, when it exists).
// No libraries. Colours come from CSS tokens, so the theme toggle needs no redraw; a resize redraws at the new width.
(function () {
  'use strict';
  var script = document.currentScript;
  var base = new URL('.', script.src);
  var root = document.documentElement;
  var ru = root.lang === 'ru';
  var NS = 'http://www.w3.org/2000/svg';
  var CH = 7.25; // JetBrains Mono at 12px: width of one character

  var T = ru ? {
    table: 'Таблица данных', loading: 'Загрузка данных…', failed: 'Не удалось загрузить data/bench.json.',
    usd: 'Сумма', share: 'Доля', events: 'Случаев', cause: 'Причина', gap: 'Пауза', requests: 'Запросов',
    model: 'Модель', week: 'Неделя с', bucket: 'Корзина', effort: 'Effort', type: 'Тип', calls: 'Вызовов',
    pair: 'Переход', prefix: 'Префикс', penalty: 'Штраф', perStep: 'Экономия за шаг', breakEven: 'Окупится через',
    tier: 'Тир', ran: 'Шла на', needed: 'Нужно по мнению судьи', n: 'n', comparison: 'Сравнение',
    agree: 'совпало', under: 'недооценка', over: 'переоценка', p50: 'p50, мс',
    main: 'основной поток', subagents: 'субагенты',
    buckets: { cacheWrite: 'запись кэша', cacheRead: 'чтение кэша', output: 'output', input: 'ввод' },
    causes: { ttl: 'истёк TTL', 'model-switch': 'смена модели', compaction: 'компакция', 'effort-change': 'смена effort', unknown: 'причина неясна' },
    gaps: { '<1m': '<1 мин', '1–5m': '1–5 мин', '5–15m': '5–15 мин', '15–60m': '15–60 мин', '>60m': '>60 мин' },
    within: 'в пределах 5 минут', beyond: 'дольше 5-минутного кэша',
    judges: { opusVsQwen: 'Opus и Qwen', qwenVsHuman: 'Qwen против меток автора', opusVsHuman: 'Opus против меток автора', publicSweQwen: 'Qwen на публичных шагах SWE' },
    ranOn: 'на чём шла задача', neededTier: 'что нужно, по мнению судьи',
    rowsRan: 'шла на', colsNeeded: 'нужно (судья) →',
    steps: function (n) { return n + ' ' + plural(n, 'шаг', 'шага', 'шагов'); },
    prefixK: function (k) { return 'префикс ' + k + 'k'; },
    criterion: 'критерий ≤ 60 мс', chosen: 'выбран',
    pending: 'ожидается', of: 'из',
  } : {
    table: 'Data table', loading: 'Loading data…', failed: 'Could not load data/bench.json.',
    usd: 'Amount', share: 'Share', events: 'Events', cause: 'Cause', gap: 'Gap', requests: 'Requests',
    model: 'Model', week: 'Week of', bucket: 'Bucket', effort: 'Effort', type: 'Type', calls: 'Calls',
    pair: 'Switch', prefix: 'Prefix', penalty: 'Penalty', perStep: 'Saving per step', breakEven: 'Break-even',
    tier: 'Tier', ran: 'Ran on', needed: 'Needed (judge)', n: 'n', comparison: 'Comparison',
    agree: 'agree', under: 'under-routing', over: 'over-routing', p50: 'p50, ms',
    main: 'main thread', subagents: 'subagents',
    buckets: { cacheWrite: 'cache write', cacheRead: 'cache read', output: 'output', input: 'input' },
    causes: { ttl: 'TTL expired', 'model-switch': 'model switch', compaction: 'compaction', 'effort-change': 'effort change', unknown: 'unclear cause' },
    gaps: {},
    within: 'within 5 minutes', beyond: 'outlives a 5-minute cache',
    judges: { opusVsQwen: 'Opus and Qwen', qwenVsHuman: "Qwen vs the author's labels", opusVsHuman: "Opus vs the author's labels", publicSweQwen: 'Qwen on public SWE steps' },
    ranOn: 'what the task ran on', neededTier: 'what the judge says it needed',
    rowsRan: 'ran on', colsNeeded: 'needed (judge) →',
    steps: function (n) { return n + (n === 1 ? ' step' : ' steps'); },
    prefixK: function (k) { return k + 'k prefix'; },
    criterion: 'criterion ≤ 60 ms', chosen: 'chosen',
    pending: 'pending', of: 'of',
  };

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ru ? ' ' : ','); }
  function num(v, d) {
    var s = Math.abs(v).toFixed(d || 0).split('.');
    return (v < 0 ? '−' : '') + group(s[0]) + (s[1] ? '.' + s[1] : '');
  }
  function usd(v, d) { return '$' + num(v, d === undefined ? (Math.abs(v) >= 100 ? 0 : 2) : d); }
  function pct(v, d) { if (v > 0 && v < 0.001 && d === undefined) return '<0.1%'; return num(v * 100, d === undefined ? (v * 100 < 10 && v > 0 ? 1 : 0) : d) + '%'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function weekLabel(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    return new Intl.DateTimeFormat(ru ? 'ru-RU' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d).replace('.', '');
  }

  // ---------- svg helpers ----------
  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, x, y, s, attrs) {
    var t = el('text', Object.assign({ x: x, y: y }, attrs || {}), parent);
    t.textContent = s;
    return t;
  }
  function svgFor(host, w, h, title, desc) {
    host.innerHTML = '';
    var s = el('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, role: 'img', 'aria-labelledby': '' }, host);
    var id = host.id || ('c' + Math.random().toString(36).slice(2));
    var ti = el('title', { id: id + '-t' }, s); ti.textContent = title;
    var de = el('desc', { id: id + '-d' }, s); de.textContent = desc || '';
    s.setAttribute('aria-labelledby', id + '-t ' + id + '-d');
    s.style.maxWidth = w + 'px';
    return s;
  }
  // A bar with a 4px rounded data end and a square baseline.
  function hbarPath(x, y, w, h, r) {
    if (w <= 0) return '';
    r = Math.min(r, w, h / 2);
    return 'M' + x + ',' + y + 'h' + (w - r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r + 'v' + (h - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r + 'h' + (r - w) + 'z';
  }
  function vbarPath(x, yBase, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, h, w / 2);
    var y = yBase - h;
    return 'M' + x + ',' + yBase + 'v' + (r - h) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + (-r) + 'h' + (w - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r + 'v' + (h - r) + 'z';
  }
  function segPath(x, y, w, h, rl, rr) {
    if (w <= 0) return '';
    rl = Math.min(rl, w / 2, h / 2); rr = Math.min(rr, w / 2, h / 2);
    return 'M' + (x + rl) + ',' + y + 'h' + (w - rl - rr) +
      (rr ? 'a' + rr + ',' + rr + ' 0 0 1 ' + rr + ',' + rr : '') + 'v' + (h - 2 * rr) +
      (rr ? 'a' + rr + ',' + rr + ' 0 0 1 ' + (-rr) + ',' + rr : '') + 'h' + (rl + rr - w) +
      (rl ? 'a' + rl + ',' + rl + ' 0 0 1 ' + (-rl) + ',' + (-rl) : '') + 'v' + (2 * rl - h) +
      (rl ? 'a' + rl + ',' + rl + ' 0 0 1 ' + rl + ',' + (-rl) : '') + 'z';
  }
  function mark(parent, d, color, tip) {
    var p = el('path', { d: d, class: 'm', style: 'fill:' + color, 'data-tip': tip }, parent);
    return p;
  }

  // ---------- data table under each chart ----------
  function table(host, head, rows) {
    var d = host.parentNode.querySelector('details.data[data-for="' + host.id + '"]');
    if (!d) {
      d = document.createElement('details');
      d.className = 'data';
      d.setAttribute('data-for', host.id);
      host.parentNode.insertBefore(d, host.nextSibling);
      // keep the caveat after the chart, the table below the caveat
      var cav = host.parentNode.querySelector('.caveat[data-for="' + host.id + '"]');
      if (cav) cav.parentNode.insertBefore(d, cav.nextSibling);
    }
    var h = '<summary>' + esc(T.table) + '</summary><div class="table-wrap"><table><thead><tr>';
    head.forEach(function (c, i) { h += '<th' + (i ? ' class="num"' : '') + ' scope="col">' + esc(c) + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>';
      r.forEach(function (c, i) { h += i ? '<td class="num">' + esc(c) + '</td>' : '<th scope="row" style="background:none;font-weight:500;color:var(--text)">' + esc(c) + '</th>'; });
      h += '</tr>';
    });
    d.innerHTML = h + '</tbody></table></div>';
  }

  // ---------- chart forms ----------
  // Horizontal bars, one row per item. rows: {label, value, valueLabel, color, tip}
  function hbars(host, rows, o) {
    var W = Math.max(280, host.clientWidth), rowH = o.rowH || 30, bh = o.bar || 14, top = o.top || 4;
    var longest = Math.max.apply(null, rows.map(function (r) { return r.label.length; })) * CH + 14;
    // Narrow screens: labels go above their bars instead of being cut.
    var above = longest > W * 0.36;
    var labW = above ? 0 : longest;
    var lift = above ? 14 : 0;
    var valW = Math.max.apply(null, rows.map(function (r) { return r.valueLabel.length; })) * CH + 12;
    var plotW = W - labW - valW;
    var max = o.max || Math.max.apply(null, rows.map(function (r) { return r.value; }));
    var heights = rows.map(function (r) { return rowH + (above && r.label ? lift : 0); });
    var plotH = heights.reduce(function (a, b) { return a + b; }, 0);
    var H = top + plotH + (o.ref ? 22 : 4);
    var s = svgFor(host, W, H, o.title, o.desc);
    if (o.ref) {
      var rx = labW + plotW * (o.ref.value / max);
      el('line', { x1: rx, x2: rx, y1: top - 2, y2: top + plotH, class: 'ref' }, s);
      text(s, rx, H - 6, o.ref.label, { 'text-anchor': rx > W - 60 ? 'end' : 'middle', class: 't-2' });
    }
    var y = top;
    rows.forEach(function (r, i) {
      var hRow = heights[i], hasLift = above && r.label;
      var cy = y + (hasLift ? lift : 0) + rowH / 2;
      if (above) { if (r.label) text(s, 0, y + 11, r.label, { class: r.strong ? 't-strong' : 't-2' }); }
      else text(s, 0, cy + 4, r.label, { class: r.strong ? 't-strong' : 't-2' });
      var w = Math.max(r.value > 0 ? 2 : 0, plotW * (r.value / max));
      var g = el('g', { 'data-tip': r.tip || (r.label + ': ' + r.valueLabel) }, s);
      el('rect', { x: labW, y: y, width: W - labW, height: hRow, fill: 'transparent' }, g);
      mark(g, hbarPath(labW, cy - bh / 2, w, bh, 4), r.color || 'var(--c1)');
      text(g, labW + w + 6, cy + 4, r.valueLabel, { class: r.strong ? 't-strong' : 't-2' });
      y += hRow;
    });
  }

  // Columns. rows: {label, value, valueLabel, color, tip}
  function columns(host, rows, o) {
    var W = Math.max(280, host.clientWidth), H = o.height || 220, padT = 22, padB = 26;
    var n = rows.length, band = W / n, bw = Math.min(o.bar || 24, band * 0.6);
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }));
    var plotH = H - padT - padB;
    var s = svgFor(host, W, H, o.title, o.desc);
    el('line', { x1: 0, x2: W, y1: H - padB + 0.5, y2: H - padB + 0.5, class: 'axis' }, s);
    rows.forEach(function (r, i) {
      var x = i * band + (band - bw) / 2, h = Math.max(r.value > 0 ? 2 : 0, plotH * (r.value / max));
      var g = el('g', { 'data-tip': r.tip || (r.label + ': ' + r.valueLabel) }, s);
      el('rect', { x: i * band, y: 0, width: band, height: H - padB, fill: 'transparent' }, g);
      mark(g, vbarPath(x, H - padB, bw, h, 4), r.color || 'var(--c1)');
      var vl = r.valueLabel;
      if (vl.length * CH > band - 2) vl = r.short || vl;
      text(g, x + bw / 2, H - padB - h - 7, vl, { 'text-anchor': 'middle', class: 't-strong' });
      text(s, x + bw / 2, H - 8, r.label, { 'text-anchor': 'middle' });
    });
  }

  // Grouped columns: groups [{label, values:[...]}], series [{name,color}]
  function grouped(host, groups, series, o) {
    var W = Math.max(280, host.clientWidth), H = o.height || 220, padT = 22, padB = 26;
    var band = W / groups.length, gap = 4, bw = Math.min(24, (band * 0.7 - gap) / series.length);
    var max = 0;
    groups.forEach(function (g) { g.values.forEach(function (v) { max = Math.max(max, v); }); });
    var plotH = H - padT - padB;
    var s = svgFor(host, W, H, o.title, o.desc);
    el('line', { x1: 0, x2: W, y1: H - padB + 0.5, y2: H - padB + 0.5, class: 'axis' }, s);
    groups.forEach(function (g, i) {
      var total = series.length * bw + (series.length - 1) * gap;
      var x0 = i * band + (band - total) / 2;
      g.values.forEach(function (v, j) {
        var x = x0 + j * (bw + gap), h = v > 0 ? Math.max(2, plotH * v / max) : 0;
        var gg = el('g', { 'data-tip': g.label + ' · ' + series[j].name + ': ' + num(v) }, s);
        el('rect', { x: x - gap / 2, y: 0, width: bw + gap, height: H - padB, fill: 'transparent' }, gg);
        if (h) mark(gg, vbarPath(x, H - padB, bw, h, 4), series[j].color);
        text(gg, x + bw / 2, H - padB - h - 7, num(v), { 'text-anchor': 'middle', class: v ? 't-strong' : '' });
      });
      text(s, i * band + band / 2, H - 8, g.label, { 'text-anchor': 'middle' });
    });
  }

  // One 100% bar split into segments with 2px surface gaps. segs: {name, value, color}
  function stackBar(host, segs, o) {
    var W = Math.max(280, host.clientWidth), bh = o.bar || 22, H = bh + 4;
    var total = segs.reduce(function (a, b) { return a + b.value; }, 0);
    var s = svgFor(host, W, H, o.title, o.desc);
    var visible = segs.filter(function (g) { return g.value / total * W >= 1; });
    var gaps = (visible.length - 1) * 2, x = 0;
    visible.forEach(function (g, i) {
      var w = (W - gaps) * g.value / total;
      var gEl = el('g', { 'data-tip': g.name + ': ' + (g.tipValue || '') + (g.tipValue ? ' · ' : '') + pct(g.value / total) }, s);
      mark(gEl, segPath(x, 2, w, bh, i === 0 ? 4 : 0, i === visible.length - 1 ? 4 : 0), g.color);
      var lab = pct(g.value / total);
      if (o.inner && w > lab.length * CH + 16) text(gEl, x + 8, 2 + bh / 2 + 4, lab, { class: 't-inv' });
      x += w + 2;
    });
  }

  // Several labelled 100% bars, one per row (judges compared).
  function stackRows(host, rows, series, o) {
    var W = Math.max(280, host.clientWidth), rowH = 50, bh = 18;
    var H = rows.length * rowH;
    var s = svgFor(host, W, H, o.title, o.desc);
    rows.forEach(function (r, i) {
      var y = i * rowH;
      text(s, 0, y + 13, r.label, { class: 't-strong' });
      text(s, W, y + 13, 'n = ' + r.n, { 'text-anchor': 'end' });
      var x = 0, by = y + 20, vis = r.values.filter(function (v) { return v > 0; }).length, k = 0;
      var gaps = (vis - 1) * 2;
      r.values.forEach(function (v, j) {
        if (!(v > 0)) return;
        var w = (W - gaps) * v;
        var g = el('g', { 'data-tip': r.label + ' · ' + series[j].name + ': ' + pct(v) + ' (n = ' + r.n + ')' }, s);
        mark(g, segPath(x, by, w, bh, k === 0 ? 4 : 0, k === vis - 1 ? 4 : 0), series[j].color);
        var lab = pct(v);
        if (w > lab.length * CH + 12) text(g, x + 6, by + bh / 2 + 4, lab, { class: 't-inv' });
        x += w + 2; k++;
      });
    });
  }

  // A heat matrix: rows x cols with counts, one hue light->dark.
  function matrix(host, rowsK, colsK, get, o) {
    var W = Math.min(Math.max(280, host.clientWidth), 520);
    var labW = 74, head = 40, cell = Math.min(110, (W - labW) / colsK.length), ch = 46;
    var H = head + rowsK.length * ch + 4;
    var s = svgFor(host, labW + cell * colsK.length, H, o.title, o.desc);
    var max = 0;
    rowsK.forEach(function (r) { colsK.forEach(function (c) { max = Math.max(max, get(r, c)); }); });
    text(s, labW, 12, o.colsTitle, { class: 't-2' });
    text(s, 0, 12, o.rowsTitle, { class: 't-2' });
    colsK.forEach(function (c, j) { text(s, labW + j * cell + cell / 2, head - 8, c, { 'text-anchor': 'middle', class: 't-strong' }); });
    rowsK.forEach(function (r, i) {
      var y = head + i * ch;
      text(s, 0, y + ch / 2 + 4, r, { class: 't-strong' });
      var rowTotal = colsK.reduce(function (a, c) { return a + get(r, c); }, 0);
      colsK.forEach(function (c, j) {
        var v = get(r, c), a = v ? 0.14 + 0.86 * (v / max) : 0;
        var g = el('g', { 'data-tip': o.tip(r, c, v, rowTotal) }, s);
        el('rect', { x: labW + j * cell + 1, y: y + 1, width: cell - 2, height: ch - 2, rx: 6, class: 'm', style: 'fill:var(--c1);fill-opacity:' + a.toFixed(3) + (v ? '' : ';fill:var(--grid);fill-opacity:1') }, g);
        text(g, labW + j * cell + cell / 2, y + ch / 2 + 4, num(v), { 'text-anchor': 'middle', class: a > 0.55 ? 't-inv' : 't-strong' });
      });
    });
  }

  // ---------- the page's charts ----------
  var CHARTS = {
    buckets: function (host, d) {
      var b = d.buckets, keys = ['cacheRead', 'cacheWrite', 'output', 'input'], colors = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];
      var total = keys.reduce(function (a, k) { return a + b[k]; }, 0);
      stackBar(host, keys.map(function (k, i) { return { name: T.buckets[k], value: b[k], color: colors[i], tipValue: usd(b[k]) }; }), {
        title: ru ? 'Из чего складывается счёт' : 'Where the bill goes', inner: true,
        desc: keys.map(function (k) { return T.buckets[k] + ' ' + pct(b[k] / total); }).join(', '),
      });
      legend(host, keys.map(function (k, i) { return { name: T.buckets[k] + ' · ' + usd(b[k]) + ' · ' + pct(b[k] / total, b[k] / total < 0.001 ? 2 : undefined), color: colors[i] }; }));
      table(host, [T.bucket, T.usd, T.share], keys.map(function (k) { return [T.buckets[k], usd(b[k], 2), pct(b[k] / total, 1)]; }));
    },
    family: function (host, d) {
      var total = d.byFamily.reduce(function (a, r) { return a + r.usd; }, 0);
      var rows = d.byFamily.slice().sort(function (a, b) { return b.usd - a.usd; });
      hbars(host, rows.map(function (r) {
        return { label: r.family, value: r.usd, valueLabel: usd(r.usd) + ' · ' + pct(r.usd / total), color: /^opus|^fable/.test(r.family) ? 'var(--c1)' : 'var(--c2)' };
      }), { title: ru ? 'Расход по семействам моделей' : 'Spend by model family' });
      legend(host, [{ name: 'Opus / Fable', color: 'var(--c1)' }, { name: 'Sonnet / Haiku', color: 'var(--c2)' }]);
      table(host, [T.model, T.usd, T.share], rows.map(function (r) { return [r.family, usd(r.usd, 2), pct(r.usd / total, 1)]; }));
    },
    effort: function (host, d) {
      var total = d.effortMix.reduce(function (a, r) { return a + r.usd; }, 0);
      var order = ['max', 'xhigh', 'high', 'medium', 'low', 'unknown'];
      var rows = d.effortMix.slice().sort(function (a, b) { return order.indexOf(a.effort) - order.indexOf(b.effort); });
      hbars(host, rows.map(function (r) { return { label: r.effort, value: r.usd, valueLabel: pct(r.usd / total), color: 'var(--c1)' }; }),
        { title: ru ? 'Расход по effort' : 'Spend by effort', rowH: 26, bar: 12 });
      table(host, [T.effort, T.usd, T.share], rows.map(function (r) { return [r.effort, usd(r.usd, 2), pct(r.usd / total, 1)]; }));
    },
    weeks: function (host, d) {
      var last = d.byWeek.length - 1;
      columns(host, d.byWeek.map(function (r, i) {
        var partial = i === 0 || i === last;
        return { label: weekLabel(r.week), value: r.usd, valueLabel: usd(r.usd), short: '$' + num(r.usd / 1000, 1) + 'k', color: partial ? 'var(--c-quiet)' : 'var(--c1)', tip: weekLabel(r.week) + ': ' + usd(r.usd) + (partial ? (ru ? ' · неполная неделя' : ' · partial week') : '') };
      }), { title: ru ? 'Расход по неделям' : 'Spend by week', height: 220 });
      table(host, [T.week, T.usd], d.byWeek.map(function (r) { return [r.week, usd(r.usd, 2)]; }));
    },
    mainsub: function (host, d) {
      var m = d.mainVsSub;
      stackBar(host, [{ name: T.main, value: m.main, color: 'var(--c1)', tipValue: usd(m.main) }, { name: T.subagents, value: m.subagents, color: 'var(--c2)', tipValue: usd(m.subagents) }],
        { title: ru ? 'Основной поток и субагенты' : 'Main thread and subagents', inner: true, bar: 18 });
      var t = m.main + m.subagents;
      legend(host, [{ name: T.main + ' · ' + usd(m.main) + ' · ' + pct(m.main / t), color: 'var(--c1)' }, { name: T.subagents + ' · ' + usd(m.subagents) + ' · ' + pct(m.subagents / t), color: 'var(--c2)' }]);
      table(host, ['', T.usd, T.share], [[T.main, usd(m.main, 2), pct(m.main / t, 1)], [T.subagents, usd(m.subagents, 2), pct(m.subagents / t, 1)]]);
    },
    subtypes: function (host, d) {
      var rows = d.subagentTypes.slice().sort(function (a, b) { return b.usd - a.usd; });
      hbars(host, rows.map(function (r) { return { label: r.type, value: r.usd, valueLabel: usd(r.usd) + ' · ' + num(r.calls), color: 'var(--c2)', tip: r.type + ': ' + usd(r.usd) + ', ' + num(r.calls) + ' ' + T.calls.toLowerCase() }; }),
        { title: ru ? 'Субагенты по типам' : 'Subagents by type', rowH: 26, bar: 12 });
      table(host, [T.type, T.usd, T.calls], rows.map(function (r) { return [r.type, usd(r.usd, 2), num(r.calls)]; }));
    },
    lossUsd: function (host, d) {
      var rows = d.cache.losses.slice().sort(function (a, b) { return b.usd - a.usd; });
      hbars(host, rows.map(function (r) { return { label: T.causes[r.cause] || r.cause, value: r.usd, valueLabel: usd(r.usd), color: 'var(--c1)', tip: (T.causes[r.cause] || r.cause) + ': ' + usd(r.usd) + ' · ' + num(r.events) + ' ' + T.events.toLowerCase() }; }),
        { title: ru ? 'Потери от промахов кэша, $' : 'Cache-miss losses, $' });
      table(host, [T.cause, T.events, T.usd], rows.map(function (r) { return [T.causes[r.cause] || r.cause, num(r.events), usd(r.usd, 2)]; }));
    },
    lossEvents: function (host, d) {
      var rows = d.cache.losses.slice().sort(function (a, b) { return b.usd - a.usd; });
      hbars(host, rows.map(function (r) { return { label: T.causes[r.cause] || r.cause, value: r.events, valueLabel: num(r.events), color: 'var(--c2)' }; }),
        { title: ru ? 'Промахи кэша, случаев' : 'Cache misses, events' });
    },
    gaps: function (host, d) {
      var beyond = { '5–15m': 1, '15–60m': 1, '>60m': 1 };
      columns(host, d.gapHistogram.map(function (r) {
        return { label: T.gaps[r.label] || r.label, value: r.count, valueLabel: num(r.count), color: beyond[r.label] ? 'var(--c1)' : 'var(--c-quiet)' };
      }), { title: ru ? 'Паузы между запросами' : 'Gaps between requests', height: 220 });
      legend(host, [{ name: T.within, color: 'var(--c-quiet)' }, { name: T.beyond, color: 'var(--c1)' }]);
      table(host, [T.gap, T.requests], d.gapHistogram.map(function (r) { return [T.gaps[r.label] || r.label, num(r.count)]; }));
    },
    switch: function (host, d) {
      var sizes = [];
      d.switchSim.forEach(function (r) { if (sizes.indexOf(r.prefixTokens) < 0) sizes.push(r.prefixTokens); });
      sizes.sort(function (a, b) { return a - b; });
      var colors = ['var(--c2)', 'var(--c1)'];
      var rows = d.switchSim.slice().sort(function (a, b) {
        var ka = a.from + a.to, kb = b.from + b.to;
        return ka === kb ? a.prefixTokens - b.prefixTokens : 0;
      });
      // keep the data's pair order, then prefix size inside a pair
      var pairs = [];
      d.switchSim.forEach(function (r) { var k = r.from + ' → ' + r.to; if (pairs.indexOf(k) < 0) pairs.push(k); });
      var list = [];
      pairs.forEach(function (p) {
        sizes.forEach(function (sz, si) {
          var r = d.switchSim.filter(function (x) { return x.from + ' → ' + x.to === p && x.prefixTokens === sz; })[0];
          if (!r) return;
          list.push({
            label: si === 0 ? p : '', value: r.breakEvenSteps, valueLabel: T.steps(r.breakEvenSteps) + ' · ' + usd(r.penalty, 2), color: colors[si % 2],
            tip: p + ' · ' + T.prefixK(Math.round(sz / 1000)) + ': ' + (ru ? 'штраф ' : 'penalty ') + usd(r.penalty, 2) + ', ' + (ru ? 'экономия ' : 'saves ') + usd(r.savingPerStep, 4) + (ru ? ' за шаг → ' : '/step → ') + T.steps(r.breakEvenSteps),
          });
        });
      });
      hbars(host, list, { title: ru ? 'Через сколько шагов окупится смена модели' : 'Steps until a mid-task switch pays off', rowH: 24, bar: 12 });
      legend(host, sizes.map(function (sz, i) { return { name: T.prefixK(Math.round(sz / 1000)), color: colors[i % 2] }; }));
      table(host, [T.pair, T.prefix, T.penalty, T.perStep, T.breakEven], rows.map(function (r) { return [r.from + ' → ' + r.to, Math.round(r.prefixTokens / 1000) + 'k', usd(r.penalty, 4), usd(r.savingPerStep, 4), T.steps(r.breakEvenSteps)]; }));
    },
    judgeTiers: function (host, d) {
      var j = d.opusJudge, tiers = ['haiku', 'sonnet', 'opus', 'fable'];
      var series = [{ name: T.ranOn, color: 'var(--c-quiet)' }, { name: T.neededTier, color: 'var(--c1)' }];
      grouped(host, tiers.map(function (t) { return { label: t, values: [j.ranOn[t] || 0, j.neededTier[t] || 0] }; }), series,
        { title: ru ? 'На чём шли задачи и что было нужно' : 'What ran vs what was needed', height: 230 });
      legend(host, series);
      table(host, [T.tier, T.ran, T.needed], tiers.map(function (t) { return [t, num(j.ranOn[t] || 0), num(j.neededTier[t] || 0)]; }));
    },
    judgeMatrix: function (host, d) {
      var m = d.opusJudge.matrix, rowsK = ['fable', 'opus', 'sonnet'], colsK = ['haiku', 'sonnet', 'opus'];
      var get = function (r, c) { var x = m.filter(function (e) { return e.ran === r && e.needed === c; })[0]; return x ? x.n : 0; };
      matrix(host, rowsK, colsK, get, {
        title: ru ? 'Матрица: на чём шла задача и что нужно' : 'Matrix: ran on vs needed', rowsTitle: T.rowsRan, colsTitle: T.colsNeeded,
        tip: function (r, c, v, tot) { return (ru ? 'шла на ' : 'ran on ') + r + ', ' + (ru ? 'нужно ' : 'needed ') + c + ': ' + num(v) + ' ' + T.of + ' ' + num(tot) + ' (' + pct(tot ? v / tot : 0) + ')'; },
      });
      var rows = [];
      rowsK.forEach(function (r) { rows.push([r].concat(colsK.map(function (c) { return num(get(r, c)); }))); });
      table(host, [T.ran + ' \\ ' + T.needed].concat(colsK), rows);
    },
    judges: function (host, d) {
      var keys = ['opusVsQwen', 'opusVsHuman', 'qwenVsHuman', 'publicSweQwen'];
      var series = [{ name: T.agree, color: 'var(--c2)' }, { name: T.under, color: 'var(--c1)' }, { name: T.over, color: 'var(--c3)' }];
      stackRows(host, keys.map(function (k) { var r = d.judges[k]; return { label: T.judges[k] + (k === 'publicSweQwen' ? ' *' : ''), n: r.n, values: [r.accuracy, r.under, r.over] }; }), series,
        { title: ru ? 'Судьи: совпадение, недооценка, переоценка' : 'Judges: agreement, under- and over-routing' });
      legend(host, series);
      table(host, [T.comparison, T.n, T.agree, T.under, T.over], keys.map(function (k) { var r = d.judges[k]; return [T.judges[k], num(r.n), pct(r.accuracy, 1), pct(r.under, 1), pct(r.over, 1)]; }));
    },
    latency: function (host, d) {
      var rows = d.studentLatency.slice().sort(function (a, b) { return a.p50ms_seq256_4threads - b.p50ms_seq256_4threads; });
      hbars(host, rows.map(function (r) {
        var on = r.model === 'multilingual-e5-small';
        return { label: r.model, value: r.p50ms_seq256_4threads, valueLabel: num(r.p50ms_seq256_4threads) + (ru ? ' мс' : ' ms') + (on ? ' · ' + T.chosen : ''), color: on ? 'var(--c1)' : 'var(--c-quiet)', strong: on };
      }), { title: ru ? 'Задержка ученика, p50' : 'Student latency, p50', ref: { value: 60, label: T.criterion }, max: 1.04 * Math.max.apply(null, rows.map(function (r) { return r.p50ms_seq256_4threads; })) });
      table(host, [T.model, T.p50], rows.map(function (r) { return [r.model, num(r.p50ms_seq256_4threads)]; }));
    },
  };

  function legend(host, items) {
    var ul = host.parentNode.querySelector('ul.legend[data-for="' + host.id + '"]');
    if (!ul) {
      ul = document.createElement('ul');
      ul.className = 'legend';
      ul.setAttribute('data-for', host.id);
      host.parentNode.insertBefore(ul, host);
    }
    ul.innerHTML = items.map(function (i) { return '<li><i style="background:' + i.color + '"></i>' + esc(i.name) + '</li>'; }).join('');
  }

  // ---------- numbers quoted in the text ----------
  function binds(d) {
    var b = d.buckets, total = b.cacheWrite + b.cacheRead + b.output + b.input;
    var m = d.opusJudge.matrix, exp = 0, cheaper = 0;
    var rank = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
    m.forEach(function (e) { if (e.ran === 'opus' || e.ran === 'fable') { exp += e.n; if (rank[e.needed] < 2) cheaper += e.n; } });
    var lossUsd = d.cache.losses.reduce(function (a, r) { return a + r.usd; }, 0);
    var ttl = d.cache.losses.filter(function (r) { return r.cause === 'ttl'; })[0] || { usd: 0, events: 0 };
    var e5 = d.studentLatency.filter(function (r) { return r.model === 'multilingual-e5-small'; })[0];
    var v = {
      total: usd(total), days: num(d.days), requests: num(d.requests), sessions: num(d.sessions),
      cacheReadPct: pct(b.cacheRead / total), cacheWritePct: pct(b.cacheWrite / total), outputPct: pct(b.output / total),
      hitRatio: pct(d.cache.hitRatio, 1), lossUsd: usd(lossUsd), ttlUsd: usd(ttl.usd), ttlEvents: num(ttl.events),
      subPct: pct(d.mainVsSub.subagents / (d.mainVsSub.main + d.mainVsSub.subagents)),
      judgeTasks: num(d.opusJudge.tasks), expTasks: num(exp), cheaperTasks: num(cheaper), cheaperPct: pct(exp ? cheaper / exp : 0),
      opusHumanUnder: pct(d.judges.opusVsHuman.under), opusHumanAcc: pct(d.judges.opusVsHuman.accuracy), opusHumanN: num(d.judges.opusVsHuman.n),
      e5: e5 ? num(e5.p50ms_seq256_4threads) : '—', generated: d.generated, pricesAsOf: d.pricesAsOf,
    };
    document.querySelectorAll('[data-bind]').forEach(function (n) { var k = n.getAttribute('data-bind'); if (v[k] !== undefined) n.textContent = v[k]; });
    // English pages quote the data file's own caveats verbatim, so they never drift from it.
    if (!ru) document.querySelectorAll('[data-note]').forEach(function (n) {
      var path = n.getAttribute('data-note').split('.'), x = d;
      path.forEach(function (p) { x = x && x[p]; });
      if (typeof x === 'string') n.textContent = x;
    });
  }

  // ---------- training run (filled later) ----------
  // Grouped horizontal bars with the label above each group (long names): groups [{label, values, strong}], series [{name,color}]
  function hgroup(host, groups, series, o) {
    var W = Math.max(280, host.clientWidth), bh = 10, gap = 3, labH = 18, after = 12;
    var valW = 6 * CH + 8, plotW = W - valW;
    var groupH = labH + series.length * (bh + gap) + after;
    var H = groups.length * groupH + (o.ref ? 20 : 0);
    var s = svgFor(host, W, H, o.title, o.desc);
    var rx = o.ref ? plotW * o.ref.value : 0;
    if (o.ref) text(s, rx, H - 4, '↑ ' + o.ref.label, { 'text-anchor': 'start', class: 't-2' });
    groups.forEach(function (g, i) {
      var y = i * groupH;
      if (o.ref) el('line', { x1: rx, x2: rx, y1: y + labH - 3, y2: y + labH + series.length * (bh + gap) + 1, class: 'ref' }, s);
      text(s, 0, y + 12, g.label, { class: g.strong ? 't-strong' : 't-2' });
      g.values.forEach(function (v, j) {
        var by = y + labH + j * (bh + gap), w = v > 0 ? Math.max(2, plotW * v) : 0;
        var gg = el('g', { 'data-tip': g.label + ' · ' + series[j].name + ': ' + pct(v, 1) }, s);
        el('rect', { x: 0, y: by - 1, width: W, height: bh + gap, fill: 'transparent' }, gg);
        if (w) mark(gg, hbarPath(0, by, w, bh, 3), series[j].color);
        text(gg, w + 6, by + bh - 1, pct(v), { class: 't-2', style: 'font-size:11px' });
      });
    });
  }

  var TR = ru ? {
    heads: { tier: 'tier — модель', effort: 'effort', plan_first: 'plan_first — сначала план', delegate_explore: 'delegate_explore — разведку субагенту' },
    usable: 'пригодна', notAlone: 'сама не решает',
    accuracy: 'точность', under: 'недооценка', macroF1: 'macro-F1', ece: 'ECE', head: 'Голова', policy: 'Политика', over: 'переоценка',
    policies: { 'student, every task': 'ученик, на каждой задаче', 'always sonnet': 'всегда sonnet', 'rules v1': 'правила v1', 'L0 (sees the finished trajectory)': 'L0 (видит готовую траекторию)', 'always opus': 'всегда opus' },
    ref: 'граница недооценки 5%', ms: ' мс',
  } : {
    heads: { tier: 'tier — the model', effort: 'effort', plan_first: 'plan_first — plan first', delegate_explore: 'delegate_explore — scout subagent' },
    usable: 'usable', notAlone: 'never acts alone',
    accuracy: 'accuracy', under: 'under-routing', macroF1: 'macro-F1', ece: 'ECE', head: 'Head', policy: 'Policy', over: 'over-routing',
    policies: {}, ref: '5% under-routing bar', ms: ' ms',
  };
  var tdata = null;
  var TCHARTS = {
    heads: function (host, t) {
      var keys = ['tier', 'effort', 'plan_first', 'delegate_explore'], ok = { plan_first: 1, delegate_explore: 1 };
      hbars(host, keys.filter(function (k) { return t.testHeads[k]; }).map(function (k) {
        var h = t.testHeads[k];
        return { label: TR.heads[k] || k, value: h.accuracy, valueLabel: pct(h.accuracy) + ' · ' + (ok[k] ? TR.usable : TR.notAlone), color: ok[k] ? 'var(--c1)' : 'var(--c-quiet)', strong: !!ok[k],
          tip: (TR.heads[k] || k) + ': ' + TR.accuracy + ' ' + pct(h.accuracy, 1) + ', ' + TR.macroF1 + ' ' + h.macro_f1.toFixed(3) + ', ' + TR.ece + ' ' + h.ece.toFixed(3) };
      }), { title: ru ? 'Точность голов ученика на тесте' : "Student's test accuracy per head", max: 1, rowH: 28, bar: 12 });
      table(host, [TR.head, TR.accuracy, TR.macroF1, TR.ece], keys.filter(function (k) { return t.testHeads[k]; }).map(function (k) { var h = t.testHeads[k]; return [k, pct(h.accuracy, 1), h.macro_f1.toFixed(3), h.ece.toFixed(3)]; }));
    },
    policies: function (host, t) {
      var series = [{ name: TR.accuracy, color: 'var(--c2)' }, { name: TR.under, color: 'var(--c1)' }];
      hgroup(host, t.tierPolicies.map(function (p) { return { label: TR.policies[p.policy] || p.policy, values: [p.accuracy, p.under], strong: /^student/.test(p.policy) }; }), series,
        { title: ru ? 'Выбор модели: ученик против простых политик' : 'Picking the model: the student vs simple policies', ref: { value: 0.05, label: TR.ref } });
      legend(host, series);
      table(host, [TR.policy, TR.accuracy, TR.under, TR.over], t.tierPolicies.map(function (p) { return [TR.policies[p.policy] || p.policy, pct(p.accuracy, 1), pct(p.under, 1), pct(p.over, 1)]; }));
    },
  };
  function drawTraining() {
    if (!tdata) return;
    document.querySelectorAll('.chart[data-train-chart]').forEach(function (h) {
      try { TCHARTS[h.getAttribute('data-train-chart')](h, tdata); } catch (err) { h.innerHTML = '<p class="err">' + esc(String(err)) + '</p>'; }
    });
  }
  function training() {
    var card = document.querySelector('[data-training]');
    if (!card) return;
    fetch(new URL('data/training.json', base), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (t) {
      tdata = t;
      var st = t.student || {};
      var v = {
        run: t.run || '', date: t.date || '', model: st.model ? st.model.replace(/^.*\//, '') : '',
        size: st.size_mb ? num(st.size_mb) + (ru ? ' МБ' : ' MB') : '', params: st.params_m ? num(st.params_m) + 'M' : '',
        p50_128: st.p50_ms_seq128 !== undefined ? num(st.p50_ms_seq128, 1) + TR.ms : '', p50_256: st.p50_ms_seq256 !== undefined ? num(st.p50_ms_seq256, 1) + TR.ms : '',
        parity: st.onnx_parity !== undefined ? st.onnx_parity.toFixed(2) : '', safe: t.safeThreshold === null ? (ru ? 'нет' : 'none') : String(t.safeThreshold),
        tierAcc: t.testHeads && t.testHeads.tier ? pct(t.testHeads.tier.accuracy) : '',
      };
      card.querySelectorAll('[data-tbind]').forEach(function (n) { var k = n.getAttribute('data-tbind'); if (v[k]) n.textContent = v[k]; });
      // The run's own words on English pages; the Russian page carries a translation of the same text.
      if (!ru) card.querySelectorAll('[data-tnote]').forEach(function (n) {
        var path = n.getAttribute('data-tnote').split('.'), x = t;
        path.forEach(function (p) { x = x && x[p]; });
        if (typeof x === 'string') n.textContent = x;
      });
      card.classList.add('is-ready');
      drawTraining();
    }).catch(function () { card.classList.add('is-pending'); });
  }

  // ---------- tooltip ----------
  var tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'presentation');
  document.body.appendChild(tip);
  function placeTip(e) {
    var x = e.clientX + 14, y = e.clientY + 14, r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  document.addEventListener('pointermove', function (e) {
    var t = e.target.closest && e.target.closest('.chart [data-tip]');
    if (!t) { tip.classList.remove('on'); return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.classList.add('on');
    placeTip(e);
  });
  document.addEventListener('pointerleave', function () { tip.classList.remove('on'); });
  window.addEventListener('scroll', function () { tip.classList.remove('on'); }, { passive: true });

  // ---------- boot ----------
  var hosts = Array.prototype.slice.call(document.querySelectorAll('.chart[data-chart]'));
  hosts.forEach(function (h) { h.innerHTML = '<p class="loading">' + esc(T.loading) + '</p>'; });
  var data = null;
  function drawAll() {
    if (!data) return;
    hosts.forEach(function (h) {
      try { CHARTS[h.getAttribute('data-chart')](h, data); } catch (err) { h.innerHTML = '<p class="err">' + esc(String(err)) + '</p>'; }
    });
  }
  fetch(new URL('data/bench.json', base)).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
    data = d;
    binds(d);
    drawAll();
  }).catch(function () {
    hosts.forEach(function (h) { h.innerHTML = '<p class="err">' + esc(T.failed) + '</p>'; });
  });
  training();
  var lastW = window.innerWidth, timer = 0;
  window.addEventListener('resize', function () {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(function () { drawAll(); drawTraining(); }, 120);
  });
})();
