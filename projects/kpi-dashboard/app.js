// Owner's KPI Dashboard for the fictional Summit Home Services.
// Plain JS, no dependencies. Charts are hand-built inline SVG.
//
// Data: the real demo jobs in window.SUMMIT (open jobs + ~5 weeks of history) are
// merged with a SIMULATED job history (fixed seed, so it is identical on every load)
// so the trends have enough data. Every number on the page comes from one job list.

(function () {
  'use strict';
  const S = window.SUMMIT;
  const DAY = 86400000, HOUR = 3600000;
  const TODAY = new Date(S.today).getTime();          // local midnight today
  const NOW = TODAY + 12 * HOUR;                        // "as of" time: today, noon
  // Local midnight n calendar days from today (n * DAY drifts an hour across DST changes).
  const dayAt = n => { const x = new Date(TODAY); x.setDate(x.getDate() + n); return x.getTime(); };
  const ts = s => (s ? new Date(s).getTime() : null);
  const vendorById = Object.fromEntries(S.vendors.map(v => [v.id, v]));
  const techById = Object.fromEntries(S.techs.map(t => [t.id, t]));
  const TRADES = ['HVAC', 'Plumbing', 'Appliance'];
  const TRADE_VAR = { HVAC: '--trade-hvac', Plumbing: '--trade-plumbing', Appliance: '--trade-appliance' };
  const OPEN = ['new', 'scheduled', 'en_route', 'in_progress', 'waiting_parts'];

  // ---------- Seeded random ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const rnd = mulberry32(20261108);
  const between = (lo, hi, r = rnd) => lo + r() * (hi - lo);
  const pick = (weighted, r = rnd) => { let x = r() * weighted.reduce((s, w) => s + w[1], 0); for (const w of weighted) { x -= w[1]; if (x <= 0) return w[0]; } return weighted[weighted.length - 1][0]; };

  // ---------- Simulated history ----------
  // Job types with price ranges similar to the real Summit jobs.
  const TEMPLATES = {
    HVAC: [['Furnace tune-up', 149, 189, 16], ['Capacitor replacement', 220, 290, 14], ['Contactor replacement', 230, 280, 8],
      ['Furnace igniter', 260, 330, 12], ['Flame sensor clean', 169, 210, 10], ['Refrigerant recharge', 420, 620, 8],
      ['Condenser fan motor', 540, 680, 7], ['Thermostat replacement', 240, 320, 10], ['Blower motor replacement', 780, 1100, 6],
      ['Inducer motor replacement', 1150, 1900, 4], ['No-heat diagnostic', 150, 189, 5]],
    Plumbing: [['Toilet rebuild', 179, 240, 18], ['Disposal replacement', 430, 520, 10], ['Disposal jam clear', 159, 199, 10],
      ['PEX leak repair', 290, 420, 14], ['T&P valve replacement', 199, 250, 10], ['Water heater replacement', 1650, 1890, 5],
      ['Drain clearing', 189, 289, 16], ['Faucet / valve replacement', 220, 340, 14]],
    Appliance: [['Washer drain pump', 248, 290, 14], ['Fridge defrost heater', 310, 360, 12], ['Oven igniter', 240, 270, 12],
      ['Dryer belt', 189, 220, 12], ['Dishwasher pump', 350, 400, 10], ['Ice maker assembly', 380, 420, 10],
      ['Sealed system repair', 520, 780, 5], ['Control board replacement', 480, 640, 8], ['Diagnostic only', 150, 160, 14]],
  };
  const TECHS_FOR = { HVAC: [['T1', 55], ['T4', 45]], Plumbing: [['T2', 1]], Appliance: [['T3', 50], ['T5', 50]] };
  const VENDORS_FOR = {
    HVAC: [['V1', 36], ['V2', 28], ['V0', 36]],
    Plumbing: [['V1', 34], ['V2', 26], ['V0', 40]],
    Appliance: [['V3', 36], ['V1', 26], ['V2', 16], ['V0', 22]],
  };
  // Callback (repeat visit) probability by tech. Luis is the outlier the story is about.
  const CALLBACK_RATE = { T1: 0.045, T2: 0.04, T3: 0.06, T4: 0.045, T5: 0.05 };
  // Hours to first call by sender. Most are well inside target; a small tail is late.
  function firstCallHours(vid) {
    switch (vid) {
      case 'V0': return rnd() < 0.03 ? between(4.2, 9) : Math.min(3.9, 0.1 + -Math.log(1 - rnd()) * 0.9);
      case 'V1': return rnd() < 0.04 ? between(24.5, 40) : 0.5 + Math.pow(rnd(), 1.6) * 22.5;
      case 'V2': return rnd() < 0.04 ? between(49, 70) : 1 + Math.pow(rnd(), 1.5) * 45;
      default:   return rnd() < 0.08 ? between(24.5, 50) : 0.6 + Math.pow(rnd(), 1.4) * 22.5;
    }
  }
  const seasonBoost = d => 0.25 * Math.exp(-Math.pow((d + 125) / 20, 2)) +          // late-summer AC rush
    1.1 * Math.pow(Math.min(1, Math.max(0, (d + 63) / 63)), 1.4);                    // heating season ramps up
  const DOW_BASE = [0.5, 4.4, 4.6, 4.6, 4.4, 4.2, 1.5];
  const HIST_DAYS = 182;

  const sim = [];
  // Error diffusion keeps volume and callbacks steady week to week (pure Poisson is too noisy for a demo).
  const volAcc = { HVAC: rnd(), Plumbing: rnd(), Appliance: rnd() };
  const cbAcc = Object.fromEntries(S.techs.map(t => [t.id, rnd()]));
  for (let d = -HIST_DAYS; d <= -1; d++) {
    const dayT = dayAt(d);
    const base = DOW_BASE[new Date(dayT).getDay()] * (d >= -34 ? 0.8 : 1); // real jobs fill the rest of the last 5 weeks
    const lambdas = { HVAC: base * 0.33 * (1 + seasonBoost(d)), Plumbing: base * 0.25, Appliance: base * 0.34 };
    for (const trade of TRADES) {
      const want = lambdas[trade] * (0.7 + 0.6 * rnd()) + volAcc[trade];
      const n = Math.floor(want); volAcc[trade] = want - n;
      for (let i = 0; i < n; i++) {
        const tpl = pick(TEMPLATES[trade].map(t => [t, t[3]]));
        const techId = pick(TECHS_FOR[trade]);
        const vendorId = pick(VENDORS_FOR[trade]);
        const completed = dayT + between(8.5, 17.5) * HOUR;
        const hrs = Math.round(between(1, 3) * 2) / 2;
        const start = completed - hrs * HOUR;
        const fcH = firstCallHours(vendorId);
        const waitParts = rnd() < 0.12;
        const gapDays = fcH / 24 + (waitParts ? between(4, 11) : between(0.4, 2.8));
        const created = start - gapDays * DAY;
        const revenue = Math.max(150, Math.min(1900, Math.round(between(tpl[1], tpl[2]))));
        sim.push({
          id: '', customerId: S.customers[Math.floor(rnd() * S.customers.length)].id, vendorId, trade, issue: tpl[0],
          status: 'invoiced', techId, simulated: true,
          created, firstCall: created + fcH * HOUR, start, completed, revenue,
          callback: (cbAcc[techId] += CALLBACK_RATE[techId] * (0.5 + rnd())) >= 1 ? (cbAcc[techId] -= 1, true) : false,
        });
      }
    }
  }
  sim.sort((a, b) => a.created - b.created);
  sim.forEach((j, i) => { j.id = 'SH-' + String(300 + i).padStart(4, '0'); });

  const real = S.jobs.map(j => ({
    id: j.id, customerId: j.customerId, vendorId: j.vendorId, trade: j.trade, issue: j.issue, status: j.status,
    techId: j.techId, simulated: false, created: ts(j.createdAt), firstCall: ts(j.firstCallAt),
    start: ts(j.scheduledStart), completed: ts(j.completedAt), revenue: j.revenue || 0, callback: !!j.callback,
  }));
  const JOBS = sim.concat(real);

  // Simulated payment dates from each sender's pay terms (Bluepeak runs late).
  for (const j of JOBS) {
    if (!j.completed) continue;
    const r = mulberry32(hashStr(j.id));
    let lag;
    switch (j.vendorId) {
      case 'V0': lag = r() < 0.9 ? 0 : between(3, 35, r); break;
      case 'V1': lag = r() < 0.92 ? between(18, 34, r) : between(35, 55, r); break;
      case 'V3': lag = r() < 0.9 ? between(20, 36, r) : between(38, 70, r); break;
      default:   lag = r() < 0.55 ? between(38, 62, r) : between(62, 105, r);
    }
    j.paid = j.completed + lag * DAY;
  }

  // ---------- Metrics ----------
  const inR = (t, a, b) => t != null && t >= a && t < b;
  const dayStart = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const ageDays = (t, at) => Math.round((dayStart(at) - dayStart(t)) / DAY);
  const deadline = j => j.created + vendorById[j.vendorId].firstCallHours * HOUR;
  // On-time status of a job's first call as of `at`: 'on' | 'late' | 'pending'
  function fcState(j, at = NOW) {
    if (j.firstCall != null && j.firstCall <= at) return j.firstCall <= deadline(j) ? 'on' : 'late';
    return at > deadline(j) ? 'late' : 'pending';
  }
  const fcHours = j => (j.firstCall != null ? (j.firstCall - j.created) / HOUR : (NOW - j.created) / HOUR);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

  function metrics(a, b) {
    const done = JOBS.filter(j => inR(j.completed, a, b));
    const revenue = sum(done, j => j.revenue);
    const callbacks = done.filter(j => j.callback).length;
    const created = JOBS.filter(j => inR(j.created, a, b));
    const called = created.filter(j => j.firstCall != null);
    const states = created.map(j => fcState(j));
    const on = states.filter(s => s === 'on').length, late = states.filter(s => s === 'late').length;
    return {
      done, created, revenue, jobs: done.length, ticket: done.length ? revenue / done.length : 0,
      callbacks, cbRate: done.length ? callbacks / done.length : 0, ftf: done.length ? 1 - callbacks / done.length : 1,
      fcAvg: called.length ? sum(called, fcHours) / called.length : 0,
      onTime: on + late ? on / (on + late) : 1, late,
    };
  }
  // Open jobs 3+ calendar days old at a point in time.
  function agedOpen(at) {
    return JOBS.filter(j => j.created <= at && (j.completed == null ? at >= TODAY : j.completed > at) && ageDays(j.created, at) >= 3);
  }
  const openNow = JOBS.filter(j => OPEN.includes(j.status));

  // ---------- Formatting ----------
  const money = n => '$' + Math.round(n).toLocaleString('en-US');
  const moneyK = n => (Math.abs(n) >= 1000 ? '$' + (n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : '$' + Math.round(n));
  const pct = (n, d = 0) => (n * 100).toFixed(d) + '%';
  const hrs = n => n.toFixed(1) + 'h';
  const fmtDate = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const first = name => name.split(' ')[0];
  const plural = (n, w, p) => n + ' ' + (n === 1 ? w : (p || w + 's'));
  const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------- DOM helpers ----------
  const $ = id => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, text, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function svgText(parent, x, y, str, attrs = {}) { const t = svgEl('text', Object.assign({ x, y }, attrs), parent); t.textContent = str; return t; }
  function newSvg(container, w, hgt, label) {
    container.textContent = '';
    return svgEl('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': label }, container);
  }
  // Bar with 4px rounded data end, square at the baseline (horizontal: grows right).
  function hBarPath(x, y, w, hh, r = 4) {
    if (w <= 0) return '';
    r = Math.min(r, w, hh / 2);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh - r}Q${x + w},${y + hh} ${x + w - r},${y + hh}H${x}Z`;
  }
  // Vertical bar growing up from baseline; rounded top only when `round`.
  function vBarPath(x, y, w, hh, round) {
    if (hh <= 0) return '';
    const r = round ? Math.min(4, w / 2, hh) : 0;
    return `M${x},${y + hh}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh}Z`;
  }
  function niceMax(v, ticks = 4) {
    if (v <= 0) return 1;
    const raw = v / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw);
    return step * ticks;
  }

  // Tooltip: rows = [{label, value, color}], built with textContent only.
  const tip = $('tip');
  function showTip(evtOrEl, title, rows, total) {
    tip.textContent = '';
    if (title) h('div', 't-h', title, tip);
    for (const r of rows) {
      const row = h('div', 't-r', null, tip);
      if (r.color) { const i = h('i', null, null, row); i.style.background = r.color; }
      h('span', null, r.label, row); h('b', null, r.value, row);
    }
    if (total) { const row = h('div', 't-r t-tot', null, tip); h('span', null, total[0], row); h('b', null, total[1], row); }
    tip.hidden = false;
    let x, y;
    if (evtOrEl.clientX != null) { x = evtOrEl.clientX; y = evtOrEl.clientY; }
    else { const bb = evtOrEl.getBoundingClientRect(); x = bb.left + bb.width / 2; y = bb.top; }
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14, top = y - th - 10;
    if (left + tw > window.innerWidth - 8) left = x - tw - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 16;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  function bindTip(node, fn) {
    node.setAttribute('tabindex', '0');
    node.addEventListener('pointermove', e => fn(e));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => fn(node));
    node.addEventListener('blur', hideTip);
  }

  // ---------- State ----------
  let DAYS = 30;
  try { const saved = Number(localStorage.getItem('kpi-period')); if ([7, 30, 90].includes(saved)) DAYS = saved; } catch (e) { /* storage blocked */ }
  if (/^#(7|30|90)d$/.test(location.hash)) DAYS = Number(location.hash.slice(1, -1));

  const periodBounds = n => ({ a: dayAt(-n), b: TODAY, pa: dayAt(-2 * n), pb: dayAt(-n) });

  // ---------- KPI tiles ----------
  const WEEKS = 13;
  const weekBuckets = Array.from({ length: WEEKS }, (_, k) => ({ a: dayAt(-7 * (WEEKS - k)), b: dayAt(-7 * (WEEKS - 1 - k)) }));
  const weekly = weekBuckets.map(w => metrics(w.a, w.b));
  const weeklyAged = weekBuckets.map((w, k) => agedOpen(k === WEEKS - 1 ? NOW : w.b).length);

  function sparkline(container, values, lowerIsBetter, label) {
    const w = 160, hh = 34;
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${hh}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label }, container);
    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const X = i => 2 + (i / (values.length - 1)) * (w - 6);
    const Y = v => 3 + (1 - (v - min) / span) * (hh - 8);
    const t0 = dayAt(-WEEKS * 7), tSpan = TODAY - t0;
    const shadeX = 2 + Math.max(0, (dayAt(-DAYS) - t0) / tSpan) * (w - 6);
    svgEl('rect', { x: shadeX, y: 0, width: w - shadeX, height: hh, fill: 'var(--accent-soft)', opacity: 0.55, rx: 3 }, svg);
    const d = values.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join('');
    svgEl('path', { d: d + `L${X(values.length - 1)},${hh}L${X(0)},${hh}Z`, fill: 'var(--accent)', opacity: 0.08 }, svg);
    svgEl('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }, svg);
    const li = values.length - 1;
    svgEl('circle', { cx: X(li), cy: Y(values[li]), r: 3, fill: 'var(--accent)', stroke: 'var(--card)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, svg);
  }

  function renderTiles(cur, prev, agedNow, agedPrev) {
    const box = $('tiles'); box.textContent = '';
    const per = `prior ${DAYS}d`;
    const fcTarget = 'Warranty target 24–48h';
    const tiles = [
      { lbl: 'Revenue', val: money(cur.revenue), d: (cur.revenue - prev.revenue) / (prev.revenue || 1), kind: 'pct', good: 1,
        spark: weekly.map(m => m.revenue), note: `${plural(cur.jobs, 'completed job')}` },
      { lbl: 'Jobs completed', val: String(cur.jobs), d: (cur.jobs - prev.jobs) / (prev.jobs || 1), kind: 'pct', good: 1,
        spark: weekly.map(m => m.jobs), note: `${(cur.jobs / DAYS * 7).toFixed(0)} per week` },
      { lbl: 'Average ticket', val: money(cur.ticket), d: (cur.ticket - prev.ticket) / (prev.ticket || 1), kind: 'pct', good: 1,
        spark: weekly.map(m => m.ticket), note: 'Revenue ÷ jobs completed' },
      { lbl: 'Avg time to first call', val: cur.fcAvg.toFixed(1), unit: 'hrs', d: cur.fcAvg - prev.fcAvg, kind: 'hrs', good: -1,
        spark: weekly.map(m => m.fcAvg), note: `${pct(cur.onTime)} inside target (${fcTarget.split(' ').pop()})` },
      { lbl: 'First-time fix rate', val: pct(cur.ftf, 1), d: cur.ftf - prev.ftf, kind: 'pts', good: 1,
        spark: weekly.map(m => m.ftf), note: `${plural(cur.callbacks, 'callback')} (repeat visits)` },
      { lbl: 'Open jobs 3+ days old', val: String(agedNow), d: agedNow - agedPrev, kind: 'count', good: -1,
        spark: weeklyAged, note: `of ${openNow.length} open right now`, vsLabel: `vs ${DAYS}d ago` },
    ];
    for (const t of tiles) {
      const el = h('div', 'tile', null, box);
      h('div', 'lbl', t.lbl, el);
      const v = h('div', 'val', t.val, el);
      if (t.unit) h('small', null, t.unit, v);
      const flat = t.kind === 'pct' ? Math.abs(t.d) < 0.005 : t.kind === 'pts' ? Math.abs(t.d) < 0.0005 : t.kind === 'hrs' ? Math.abs(t.d) < 0.05 : t.d === 0;
      const better = t.d * t.good > 0;
      const dl = h('div', 'delta ' + (flat ? 'flat' : better ? 'good' : 'bad'), null, el);
      const arrow = flat ? '→' : t.d > 0 ? '▲' : '▼';
      const mag = t.kind === 'pct' ? pct(Math.abs(t.d), 1) : t.kind === 'pts' ? (Math.abs(t.d) * 100).toFixed(1) + ' pts'
        : t.kind === 'hrs' ? Math.abs(t.d).toFixed(1) + 'h' : String(Math.abs(t.d));
      h('span', null, arrow, dl).setAttribute('aria-hidden', 'true');
      h('span', null, flat ? 'No change' : mag, dl);
      h('span', 'vs', t.vsLabel || 'vs ' + per, dl);
      h('span', 'sr', flat ? '' : better ? '(better)' : '(worse)', dl);
      const vals = t.spark;
      sparkline(el, vals, t.good < 0, `${t.lbl}, weekly for the last 13 weeks: from ${fmtSpark(t, vals[0])} to ${fmtSpark(t, vals[vals.length - 1])}`);
      h('div', 'note', t.note, el);
    }
  }
  function fmtSpark(t, v) {
    if (t.lbl === 'Revenue' || t.lbl === 'Average ticket') return money(v);
    if (t.kind === 'pts') return pct(v, 1);
    if (t.kind === 'hrs') return hrs(v);
    return String(Math.round(v));
  }

  // ---------- Revenue by trade (stacked columns) ----------
  function tradeBuckets(n) {
    const { a } = periodBounds(n);
    if (n <= 30) return Array.from({ length: n }, (_, i) => ({ a: dayAt(i - n), b: dayAt(i - n + 1), label: fmtDate(dayAt(i - n)), daily: true }));
    const out = [];
    for (let w = 0; dayAt(-7 * w) > a; w++) out.unshift({ a: Math.max(a, dayAt(-7 * (w + 1))), b: dayAt(-7 * w) });
    out.forEach(k => { k.label = fmtDate(k.a); k.days = Math.round((k.b - k.a) / DAY); });
    return out;
  }
  function renderTrade(cur, prev) {
    const box = $('trade');
    const buckets = tradeBuckets(DAYS).map(k => {
      const jobs = cur.done.filter(j => inR(j.completed, k.a, k.b));
      const by = Object.fromEntries(TRADES.map(t => [t, sum(jobs.filter(j => j.trade === t), j => j.revenue)]));
      return Object.assign(k, { by, total: sum(jobs, j => j.revenue), n: jobs.length });
    });
    const W = Math.max(300, box.clientWidth), H = 230, ml = 44, mr = 6, mt = 10, mb = 26;
    const pw = W - ml - mr, ph = H - mt - mb;
    const maxV = niceMax(Math.max(...buckets.map(k => k.total)));
    const svg = newSvg(box, W, H, `Stacked columns: revenue by trade, ${buckets[0].daily ? 'per day' : 'per week'}, last ${DAYS} days. Total ${money(cur.revenue)}.`);
    for (let i = 0; i <= 4; i++) {
      const y = mt + ph - (i / 4) * ph;
      svgEl('line', { x1: ml, x2: W - mr, y1: y, y2: y, class: i ? 'gridline' : 'baseline' }, svg);
      svgText(svg, ml - 8, y + 4, moneyK(maxV * i / 4), { 'text-anchor': 'end' });
    }
    const slot = pw / buckets.length, bw = Math.min(24, Math.max(4, slot * 0.62));
    const labelEvery = Math.ceil(buckets.length / Math.max(2, Math.floor(pw / 62)));
    buckets.forEach((k, i) => {
      const x = ml + i * slot + (slot - bw) / 2;
      const g = svgEl('g', { class: 'col', role: 'listitem', 'aria-label': `${k.label}: ${money(k.total)}` }, svg);
      svgEl('rect', { x: ml + i * slot, y: mt, width: slot, height: ph, class: 'hit' }, g);
      const marks = svgEl('g', { class: 'marks' }, g);
      let y = mt + ph;
      const present = TRADES.filter(t => k.by[t] > 0);
      present.forEach((t, ti) => {
        const hh = (k.by[t] / maxV) * ph;
        const top = ti === present.length - 1;
        const segH = Math.max(0, hh - (ti ? 2 : 0));
        svgEl('path', { d: vBarPath(x, y - hh, bw, segH, top), fill: `var(${TRADE_VAR[t]})` }, marks);
        y -= hh;
      });
      if (i % labelEvery === (buckets.length - 1) % labelEvery) svgText(svg, x + bw / 2, H - 8, k.label, { 'text-anchor': 'middle' });
      bindTip(g, e => showTip(e, (k.daily ? new Date(k.a).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : `Week of ${k.label}${k.days < 7 ? ` (${k.days} days)` : ''}`),
        TRADES.map(t => ({ label: t, value: money(k.by[t]), color: cssVar(TRADE_VAR[t]) })), ['Total · ' + plural(k.n, 'job'), money(k.total)]));
    });
    // Legend + subtitle
    const lg = $('trade-legend'); lg.textContent = '';
    const shareNow = Object.fromEntries(TRADES.map(t => [t, sum(cur.done.filter(j => j.trade === t), j => j.revenue)]));
    const sharePrev = Object.fromEntries(TRADES.map(t => [t, sum(prev.done.filter(j => j.trade === t), j => j.revenue)]));
    TRADES.forEach(t => { const s = h('span', null, null, lg); h('i', null, null, s).style.background = `var(${TRADE_VAR[t]})`; h('span', null, `${t} ${money(shareNow[t])}`, s); });
    $('trade-chip').textContent = (buckets[0].daily ? 'Daily' : 'Weekly') + ` · ${DAYS} days`;
    const lead = TRADES.slice().sort((x, y) => shareNow[y] - shareNow[x])[0];
    $('trade-sub').textContent = `${money(cur.revenue)} total. ${lead} is ${pct(shareNow[lead] / (cur.revenue || 1))} of revenue` +
      (sharePrev[lead] ? `, ${shareNow[lead] >= sharePrev[lead] ? 'up' : 'down'} ${pct(Math.abs(shareNow[lead] - sharePrev[lead]) / sharePrev[lead])} on the prior ${DAYS} days.` : '.');
    // Table view
    const tb = $('trade-table'); tb.textContent = '';
    const table = h('table', null, null, tb);
    const hr = h('tr', null, null, h('thead', null, null, table));
    h('th', null, buckets[0].daily ? 'Day' : 'Week of', hr); TRADES.concat('Total').forEach(t => h('th', 'n', t, hr));
    const tbody = h('tbody', null, null, table);
    buckets.forEach(k => { const r = h('tr', null, null, tbody); h('td', null, k.label, r); TRADES.forEach(t => h('td', 'n', money(k.by[t]), r)); h('td', 'n', money(k.total), r); });
  }

  // ---------- Per-tech stats ----------
  function techStats(m) {
    return S.techs.map(t => {
      const done = m.done.filter(j => j.techId === t.id);
      const called = m.created.filter(j => j.techId === t.id && j.firstCall != null);
      const rev = sum(done, j => j.revenue), cb = done.filter(j => j.callback);
      return { t, jobs: done.length, rev, ticket: done.length ? rev / done.length : 0, cb: cb.length, cbRate: done.length ? cb.length / done.length : 0,
        fc: called.length ? sum(called, fcHours) / called.length : null, cbJobs: cb };
    }).sort((a, b) => b.rev - a.rev);
  }

  function renderTechBars(stats) {
    const box = $('techbars');
    const W = Math.max(280, box.clientWidth), rowH = 46, H = stats.length * rowH;
    const svg = newSvg(box, W, H, 'Horizontal bars: revenue per tech. ' + stats.map(s => `${s.t.name} ${money(s.rev)}, ${s.jobs} jobs`).join('; '));
    const max = Math.max(...stats.map(s => s.rev)) || 1, valW = 64, bw = W - valW - 4;
    stats.forEach((s, i) => {
      const y = i * rowH;
      const g = svgEl('g', { class: 'col' }, svg);
      svgEl('rect', { x: 0, y, width: W, height: rowH, class: 'hit' }, g);
      svgText(g, 0, y + 15, s.t.name, { class: 'ink' });
      svgText(g, W, y + 15, `${s.jobs} jobs · ${money(s.ticket)} avg`, { 'text-anchor': 'end', class: 'soft' });
      svgEl('rect', { x: 0, y: y + 23, width: bw, height: 12, rx: 4, fill: 'var(--bg-2)' }, g);
      const marks = svgEl('g', { class: 'marks' }, g);
      svgEl('path', { d: hBarPath(0, y + 23, Math.max(2, (s.rev / max) * bw), 12), fill: 'var(--bar)' }, marks);
      svgText(g, W, y + 33.5, money(s.rev), { 'text-anchor': 'end', class: 'ink' });
      bindTip(g, e => showTip(e, s.t.name + ' · ' + s.t.trade, [
        { label: 'Revenue', value: money(s.rev) }, { label: 'Jobs', value: String(s.jobs) },
        { label: 'Avg ticket', value: money(s.ticket) }, { label: 'Callbacks', value: `${s.cb} (${pct(s.cbRate, 1)})` }]));
    });
    $('tech-chip').textContent = `${DAYS} days`;
  }

  // ---------- Pipeline ----------
  function renderPipeline() {
    const box = $('pipeline');
    const stages = OPEN.map(st => {
      const jobs = openNow.filter(j => j.status === st);
      const aged = jobs.filter(j => ageDays(j.created, NOW) >= 3);
      return { st, label: S.statusLabels[st], jobs, aged, unassigned: jobs.filter(j => !j.techId).length };
    }).filter(s => s.jobs.length || s.st !== 'en_route');
    const W = Math.max(280, box.clientWidth), rowH = 40, labW = 118, valW = 30, H = stages.length * rowH;
    const svg = newSvg(box, W, H, 'Open jobs by stage: ' + stages.map(s => `${s.label} ${s.jobs.length} (${s.aged.length} 3+ days old)`).join('; '));
    const max = Math.max(...stages.map(s => s.jobs.length)) || 1, bw = W - labW - valW - 8;
    stages.forEach((s, i) => {
      const y = i * rowH + 8;
      const g = svgEl('g', { class: 'col' }, svg);
      svgEl('rect', { x: 0, y: y - 8, width: W, height: rowH, class: 'hit' }, g);
      svgText(g, 0, y + 13, s.label, { class: 'ink' });
      const marks = svgEl('g', { class: 'marks' }, g);
      const unit = bw / max, fresh = s.jobs.length - s.aged.length;
      if (fresh) svgEl('path', { d: s.aged.length ? `M${labW},${y}h${fresh * unit - 2}v18h${-(fresh * unit - 2)}Z` : hBarPath(labW, y, fresh * unit, 18), fill: 'var(--bar)' }, marks);
      if (s.aged.length) svgEl('path', { d: hBarPath(labW + fresh * unit, y, s.aged.length * unit, 18), fill: 'var(--warn)' }, marks);
      if (!s.jobs.length) svgEl('line', { x1: labW, x2: labW, y1: y, y2: y + 18, class: 'baseline' }, svg);
      svgText(g, labW + s.jobs.length * unit + 8, y + 13.5, String(s.jobs.length), { class: 'ink' });
      const oldest = s.jobs.length ? Math.max(...s.jobs.map(j => ageDays(j.created, NOW))) : 0;
      bindTip(g, e => showTip(e, s.label, [
        { label: 'Jobs', value: String(s.jobs.length) }, { label: '3+ days old', value: String(s.aged.length) },
        { label: 'No tech assigned', value: String(s.unassigned) }, { label: 'Oldest', value: plural(oldest, 'day') }],
        s.jobs.length ? ['Jobs', s.jobs.map(j => j.id).slice(0, 4).join(', ') + (s.jobs.length > 4 ? '…' : '')] : null));
    });
    const aged = openNow.filter(j => ageDays(j.created, NOW) >= 3).length;
    $('pipe-sub').textContent = `${openNow.length} open jobs. Amber = 3+ days since the work order came in (${aged}).`;
  }

  // ---------- First call vs target (small multiples) ----------
  const EDGES = [0, 2, 4, 8, 12, 24, 36, 48, 72, Infinity];
  function renderFirstCall(cur) {
    const box = $('firstcall'); box.textContent = '';
    const order = ['V1', 'V2', 'V3', 'V0'];
    const groups = order.map(vid => {
      const v = vendorById[vid];
      const jobs = cur.created.filter(j => j.vendorId === vid && fcState(j) !== 'pending');
      const bins = EDGES.slice(0, -1).map(() => ({ on: 0, late: 0 }));
      let on = 0;
      jobs.forEach(j => {
        const hh = fcHours(j), bi = EDGES.findIndex((e, i) => hh >= e && hh < EDGES[i + 1]);
        const st = fcState(j); bins[bi][st === 'on' ? 'on' : 'late']++; if (st === 'on') on++;
      });
      const called = jobs.filter(j => j.firstCall != null);
      return { v, jobs, bins, on, rate: jobs.length ? on / jobs.length : 1, avg: called.length ? sum(called, fcHours) / called.length : 0 };
    });
    const bw0 = box.clientWidth, cols = bw0 > 960 ? 4 : bw0 > 520 ? 2 : 1;
    box.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const cellW = Math.max(220, (bw0 - (cols - 1) * 22) / cols);
    groups.forEach(g => {
      const yMax = Math.min(1, niceMax(Math.max(...g.bins.map(b => g.jobs.length ? (b.on + b.late) / g.jobs.length : 0)), 2));
      const cell = h('div', 'fc-cell', null, box);
      const h3 = h('h3', null, null, cell);
      h('span', null, g.v.short === 'Direct' ? 'Direct customers' : g.v.short, h3);
      const cls = g.rate >= 0.95 ? 'good' : g.rate >= 0.88 ? 'warn' : 'bad';
      h('span', 'pct ' + cls, (cls === 'good' ? '✓ ' : '! ') + pct(g.rate) + ' on time', h3);
      h('div', 'meta', `${g.v.firstCallHours}h target · ${plural(g.jobs.length, 'job')} · avg ${hrs(g.avg)}`, cell);
      const W = cellW, H = 104, ml = 2, mr = 2, mt = 14, mb = 18, pw = W - ml - mr, ph = H - mt - mb;
      const wrap = h('div', null, null, cell);
      const svg = newSvg(wrap, W, H, `${g.v.short}: ${pct(g.rate)} of ${g.jobs.length} first calls inside the ${g.v.firstCallHours} hour target; average ${hrs(g.avg)}.`);
      const nb = g.bins.length, slot = pw / nb, bw = Math.min(24, slot - 2);
      svgEl('line', { x1: ml, x2: W - mr, y1: mt, y2: mt, class: 'gridline' }, svg);
      svgEl('line', { x1: ml, x2: W - mr, y1: mt + ph, y2: mt + ph, class: 'baseline' }, svg);
      g.bins.forEach((b, i) => {
        const tot = b.on + b.late, share = g.jobs.length ? tot / g.jobs.length : 0;
        const x = ml + i * slot + (slot - bw) / 2;
        const gg = svgEl('g', { class: 'col' }, svg);
        svgEl('rect', { x: ml + i * slot, y: mt, width: slot, height: ph, class: 'hit' }, gg);
        const hh = (share / yMax) * ph;
        const late = EDGES[i] >= g.v.firstCallHours;
        if (tot) svgEl('path', { d: vBarPath(x, mt + ph - hh, bw, hh, true), fill: late ? 'var(--late)' : 'var(--bar)' }, svgEl('g', { class: 'marks' }, gg));
        const rng = EDGES[i + 1] === Infinity ? `${EDGES[i]}h+` : `${EDGES[i]}–${EDGES[i + 1]}h`;
        bindTip(gg, e => showTip(e, `${g.v.short} · ${rng}`, [{ label: 'Jobs', value: String(tot) }, { label: 'Share', value: pct(share) },
          { label: late ? 'Past target' : 'Inside target', value: late ? '!' : '✓' }]));
      });
      // edge ticks
      EDGES.slice(0, -1).forEach((e, i) => { if (i % (pw < 300 ? 2 : 1) === 0 || i === nb - 1) svgText(svg, ml + i * slot, H - 4, String(e), { 'text-anchor': i ? 'middle' : 'start' }); });
      svgText(svg, W - mr, H - 4, 'h', { 'text-anchor': 'end' });
      svgText(svg, ml, mt - 4, pct(yMax) + ' of jobs', { class: 'soft' });
      const ti = EDGES.indexOf(g.v.firstCallHours), tx = ml + ti * slot;
      svgEl('line', { x1: tx, x2: tx, y1: mt - 2, y2: mt + ph, stroke: 'var(--ink)', 'stroke-width': 1.5 }, svg);
      svgText(svg, tx + 4, mt + 8, `${g.v.firstCallHours}h`, { class: 'ink' });
    });
    const lg = $('fc-legend'); lg.textContent = '';
    [['var(--bar)', 'Inside target'], ['var(--late)', 'Past target (or still not called)']].forEach(([c, l]) => { const s = h('span', null, null, lg); h('i', null, null, s).style.background = c; h('span', null, l, s); });
    { const s = h('span', null, null, lg); const i = h('i', 'line', null, s); i.style.background = 'var(--ink)'; h('span', null, 'Deadline', s); }
    $('fc-chip').textContent = `Received · ${DAYS} days`;
    return groups;
  }

  // ---------- Accounts receivable ----------
  const AGE_BUCKETS = [['0–30 days', 0, 31, '--age-1'], ['31–60 days', 31, 61, '--age-2'], ['61+ days', 61, Infinity, '--age-3']];
  function arData() {
    const unpaid = JOBS.filter(j => j.completed != null && j.completed <= NOW && j.paid > NOW);
    return ['V2', 'V1', 'V3', 'V0'].map(vid => {
      const jobs = unpaid.filter(j => j.vendorId === vid).map(j => Object.assign(j, { age: ageDays(j.completed, NOW) }));
      const by = AGE_BUCKETS.map(([, lo, hi]) => sum(jobs.filter(j => j.age >= lo && j.age < hi), j => j.revenue));
      const termDays = parseInt((vendorById[vid].payTerms.match(/\d+/) || ['0'])[0], 10);
      const past = jobs.filter(j => j.age > termDays);
      return { v: vendorById[vid], jobs, by, total: sum(jobs, j => j.revenue), termDays, past, pastAmt: sum(past, j => j.revenue) };
    }).sort((a, b) => b.total - a.total);
  }
  function renderAR(ar) {
    const box = $('ar');
    const W = Math.max(280, box.clientWidth), rowH = 48, H = ar.length * rowH, valW = 62, bw = W - valW;
    const svg = newSvg(box, W, H, 'Stacked bars: unpaid invoices by sender and age. ' + ar.map(r => `${r.v.short} ${money(r.total)}`).join('; '));
    const max = Math.max(...ar.map(r => r.total)) || 1;
    ar.forEach((r, i) => {
      const y = i * rowH;
      const g = svgEl('g', { class: 'col' }, svg);
      svgEl('rect', { x: 0, y, width: W, height: rowH, class: 'hit' }, g);
      svgText(g, 0, y + 15, r.v.short === 'Direct' ? 'Direct customers' : r.v.short, { class: 'ink' });
      svgText(g, W, y + 15, `${r.v.payTerms} · ${plural(r.jobs.length, 'invoice')}`, { 'text-anchor': 'end', class: 'soft' });
      const marks = svgEl('g', { class: 'marks' }, g);
      let x = 0;
      const segs = r.by.map((v, k) => [v, k]).filter(([v]) => v > 0);
      segs.forEach(([v, k], si) => {
        const w = (v / max) * (bw - 6), last = si === segs.length - 1;
        const ww = Math.max(1, w - (last ? 0 : 2));
        svgEl('path', { d: last ? hBarPath(x, y + 23, ww, 14) : `M${x},${y + 23}h${ww}v14h${-ww}Z`, fill: `var(${AGE_BUCKETS[k][3]})` }, marks);
        x += w;
      });
      svgText(g, x + 6, y + 34.5, moneyK(r.total), { class: 'ink' });
      bindTip(g, e => showTip(e, r.v.name, AGE_BUCKETS.map(([l, , , c], k) => ({ label: l, value: money(r.by[k]), color: cssVar(c) })),
        ['Total unpaid', money(r.total)]));
    });
    const total = sum(ar, r => r.total), over60 = sum(ar, r => r.by[2]);
    $('ar-sub').textContent = `${money(total)} unpaid on completed jobs. ${money(over60)} of it is more than 60 days old.`;
    const lg = $('ar-legend'); lg.textContent = '';
    AGE_BUCKETS.forEach(([l, , , c]) => { const s = h('span', null, null, lg); h('i', null, null, s).style.background = `var(${c})`; h('span', null, l, s); });
    const tb = $('ar-table'); tb.textContent = '';
    const table = h('table', null, null, tb);
    const hr = h('tr', null, null, h('thead', null, null, table));
    ['Sender', ...AGE_BUCKETS.map(b => b[0]), 'Total'].forEach((t, i) => h('th', i ? 'n' : null, t, hr));
    const tbody = h('tbody', null, null, table);
    ar.forEach(r => { const tr = h('tr', null, null, tbody); h('td', null, r.v.short, tr); r.by.forEach(v => h('td', 'n', money(v), tr)); h('td', 'n', money(r.total), tr); });
  }

  // ---------- Leaderboard ----------
  function renderLeaderboard(stats, cur) {
    const t = $('leaderboard'); t.textContent = '';
    const hr = h('tr', null, null, h('thead', null, null, t));
    [['Tech'], ['Jobs', 'n'], ['Revenue', 'n'], ['Avg ticket', 'n'], ['Avg first call', 'n'], ['Callback rate', 'n']].forEach(([l, c]) => h('th', c || null, l, hr));
    const tb = h('tbody', null, null, t);
    const maxRev = Math.max(...stats.map(s => s.rev)) || 1;
    const maxCb = Math.max(0.1, ...stats.map(s => s.cbRate));
    stats.forEach(s => {
      const tr = h('tr', null, null, tb);
      const who = h('div', 'who', null, h('td', null, null, tr));
      h('span', 'av', s.t.initials, who).setAttribute('aria-hidden', 'true');
      const nm = h('span', null, s.t.name, who); h('span', 'trade', s.t.trade, nm);
      h('td', 'n', String(s.jobs), tr);
      const rc = h('div', 'cellbar', null, h('td', 'n', null, tr));
      h('span', null, null, h('div', 'b', null, rc)).style.width = (s.rev / maxRev * 100) + '%';
      h('span', 'v', money(s.rev), rc);
      h('td', 'n', money(s.ticket), tr);
      h('td', 'n', s.fc == null ? '—' : hrs(s.fc), tr);
      const high = s.jobs >= 6 && s.cbRate >= Math.max(0.06, cur.cbRate * 1.6);
      const cc = h('div', 'cellbar', null, h('td', 'n', null, tr));
      h('span', null, null, h('div', 'b' + (high ? ' bad' : ''), null, cc)).style.width = (s.cbRate / maxCb * 100) + '%';
      h('span', 'v', `${pct(s.cbRate, 1)}${high ? ' !' : ''}`, cc);
    });
    const ft = h('tr', null, null, h('tfoot', null, null, t));
    h('td', null, 'Team', ft); h('td', 'n', String(cur.jobs), ft); h('td', 'n', money(cur.revenue), ft);
    h('td', 'n', money(cur.ticket), ft); h('td', 'n', hrs(cur.fcAvg), ft); h('td', 'n', pct(cur.cbRate, 1), ft);
    $('lb-chip').textContent = `${DAYS} days`;
  }

  // ---------- Needs your attention ----------
  function buildAttention(cur, prev, stats, ar, fcGroups) {
    const items = [];
    // 1. No first call and past the sender's deadline (live).
    const overdue = openNow.filter(j => j.firstCall == null && NOW > deadline(j)).sort((a, b) => deadline(a) - deadline(b));
    if (overdue.length) {
      const lateH = j => (NOW - deadline(j)) / HOUR;
      items.push({ sev: 'critical', tag: 'Today',
        title: `${plural(overdue.length, 'job has', 'jobs have')} no first call and ${overdue.length === 1 ? 'is' : 'are'} past the warranty deadline`,
        body: `Call these customers before anything else today. Missed first-contact deadlines are how warranty companies decide who gets fewer work orders.`,
        refs: overdue.map(j => `${j.id} · ${vendorById[j.vendorId].short} · ${Math.round(lateH(j))}h late`) });
    }
    // 2. A tech whose callback rate is well above the rest of the team.
    function cbOutlier(m, label) {
      const st = techStats(m);
      for (const s of st.slice().sort((a, b) => b.cbRate - a.cbRate)) {
        const rest = m.done.filter(j => j.techId !== s.t.id), restRate = rest.length ? rest.filter(j => j.callback).length / rest.length : 0;
        if (s.jobs >= 8 && s.cb >= 2 && s.cbRate >= Math.max(0.06, restRate * 1.75)) return { s, restRate, label };
        break;
      }
      return null;
    }
    // Callback rates need a decent sample to be fair to a tech, so judge on at least 90 days.
    const cbo = DAYS >= 90 ? cbOutlier(cur, `the last ${DAYS} days`) : cbOutlier(metrics(dayAt(-90), TODAY), 'the last 90 days');
    if (cbo) {
      const { s, restRate } = cbo, ratio = s.cbRate / (restRate || 0.01);
      const lastCb = s.cbJobs.slice().sort((a, b) => b.completed - a.completed).slice(0, 3);
      const lost = sum(s.cbJobs, () => S.company.tripCharge + S.company.laborRate * 1.5);
      items.push({ sev: 'warning', tag: 'Quality',
        title: `${first(s.t.name)}'s callback rate is ${pct(s.cbRate)}, about ${ratio >= 1.9 ? Math.round(ratio) + 'x' : ratio.toFixed(1) + 'x'} the rest of the team (${pct(restRate)})`,
        body: `${plural(s.cb, 'repeat visit')} on ${s.jobs} jobs over ${cbo.label}, roughly ${money(lost)} of unpaid return trips. Review the last ${lastCb.length} with ${first(s.t.name)}: same part, same model, or a skipped step?`,
        refs: lastCb.map(j => `${j.id} · ${j.issue} · ${fmtDate(j.completed)}`) });
    }
    // 3. Receivables past terms.
    ar.filter(r => r.v.id !== 'V0' && r.pastAmt >= 500).sort((a, b) => b.pastAmt - a.pastAmt).forEach((r, i) => {
      const oldest = r.past.slice().sort((a, b) => b.age - a.age)[0];
      const over = r.jobs.filter(j => j.age > 45), overAmt = sum(over, j => j.revenue);
      items.push({ sev: i === 0 && r.pastAmt >= 2500 ? 'warning' : 'info', tag: 'Cash',
        title: r.termDays >= 45
          ? `${r.v.short} owes ${money(overAmt)} on ${plural(over.length, 'invoice')} over 45 days old`
          : `${r.v.short} has ${money(r.pastAmt)} past its ${r.v.payTerms} terms`,
        body: `${r.v.payTerms} terms, so these are late. Oldest is ${oldest.id} at ${oldest.age} days. ${r.by[2] ? money(r.by[2]) + ' is past 60 days. ' : ''}Send a statement and ask for a payment date.`,
        refs: r.past.slice().sort((a, b) => b.age - a.age).slice(0, 3).map(j => `${j.id} · ${money(j.revenue)} · ${j.age}d`) });
    });
    // 4. Stuck waiting on parts.
    const parts = openNow.filter(j => j.status === 'waiting_parts');
    if (parts.length) {
      const oldest = Math.max(...parts.map(j => ageDays(j.created, NOW)));
      items.push({ sev: 'warning', tag: 'Jobs',
        title: `${plural(parts.length, 'job is', 'jobs are')} stuck waiting on parts, oldest ${oldest} days`,
        body: 'Customers on these jobs have no working equipment. Chase the parts orders and give each customer a date.',
        refs: parts.map(j => `${j.id} · ${j.issue} · ${ageDays(j.created, NOW)}d`) });
    }
    // 5. New jobs with nobody assigned.
    const unassigned = openNow.filter(j => !j.techId);
    if (unassigned.length) {
      items.push({ sev: unassigned.some(j => ageDays(j.created, NOW) >= 2) ? 'warning' : 'info', tag: 'Dispatch',
        title: `${plural(unassigned.length, 'new job has', 'new jobs have')} no tech assigned`,
        body: `The oldest came in ${plural(Math.max(...unassigned.map(j => ageDays(j.created, NOW))), 'day')} ago. Assign them so the first call can happen.`,
        refs: unassigned.sort((a, b) => a.created - b.created).map(j => `${j.id} · ${j.trade} · ${fmtDate(j.created)}`) });
    }
    // 6. Sender with first-call on-time below 90% in the period.
    fcGroups.filter(g => g.jobs.length >= 10 && g.rate < 0.9).sort((x, y) => x.rate - y.rate).slice(0, 1).forEach(g => {
      items.push({ sev: 'warning', tag: 'Speed',
        title: `Only ${pct(g.rate)} of ${g.v.short === 'Direct' ? 'direct customers' : g.v.short} first calls were inside the ${g.v.firstCallHours}h target`,
        body: `${g.jobs.length - g.on} of ${g.jobs.length} jobs received in the last ${DAYS} days were called late. Check who is assigned these and whether they are being called the same day.`, refs: [] });
    });
    // 7. Trade trend (good news / context).
    const tr = TRADES.map(t => ({ t, now: sum(cur.done.filter(j => j.trade === t), j => j.revenue), prev: sum(prev.done.filter(j => j.trade === t), j => j.revenue) }))
      .filter(x => x.prev > 0).sort((a, b) => (b.now / b.prev) - (a.now / a.prev))[0];
    if (tr && tr.now / tr.prev > 1.1) {
      const techs = S.techs.filter(t => t.trade === tr.t).map(t => first(t.name));
      items.push({ sev: 'info', tag: 'Trend',
        title: `${tr.t} revenue is up ${pct(tr.now / tr.prev - 1)} on the prior ${DAYS} days`,
        body: tr.t === 'HVAC' ? `Heating season is starting. ${techs.join(' and ')} carry all HVAC work, so watch their schedules and first-call times before they slip.`
          : `${techs.join(' and ')} handled this work.`, refs: [] });
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    return items.sort((a, b) => rank[a.sev] - rank[b.sev]).slice(0, 7);
  }
  function renderAttention(items) {
    const ol = $('attn'); ol.textContent = '';
    const icon = { critical: '!', warning: '!', info: 'i' };
    const sevLabel = { critical: 'Urgent', warning: 'Watch', info: 'FYI' };
    items.forEach(it => {
      const li = h('li', null, null, ol);
      h('div', 'attn-ic ' + it.sev, icon[it.sev], li).setAttribute('aria-hidden', 'true');
      const body = h('div', null, null, li);
      h('div', 'attn-tag ' + it.sev, `${sevLabel[it.sev]} · ${it.tag}`, body);
      h('div', 'attn-title', it.title, body);
      h('div', 'attn-body', it.body, body);
      if (it.refs.length) { const r = h('div', 'attn-refs', null, body); it.refs.forEach(x => h('span', 'chip', x, r)); }
    });
    const urgent = items.filter(i => i.sev === 'critical').length;
    const chip = $('attn-count');
    chip.textContent = `${plural(items.length, 'item')}${urgent ? ` · ${urgent} urgent` : ''}`;
    chip.className = 'chip' + (urgent ? ' bad' : '');
  }

  // ---------- Render ----------
  function render() {
    const { a, b, pa, pb } = periodBounds(DAYS);
    const cur = metrics(a, b), prev = metrics(pa, pb);
    document.querySelectorAll('#period button').forEach(btn => {
      const on = Number(btn.dataset.days) === DAYS;
      btn.setAttribute('aria-checked', on); btn.tabIndex = on ? 0 : -1;
    });
    $('asof').textContent = `${fmtDate(a)} – ${fmtDate(b - DAY)} · as of today ${new Date(NOW).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    renderTiles(cur, prev, agedOpen(NOW).length, agedOpen(dayAt(-DAYS) + 12 * HOUR).length);
    renderTrade(cur, prev);
    const stats = techStats(cur);
    renderTechBars(stats);
    renderPipeline();
    const fcGroups = renderFirstCall(cur);
    const ar = arData();
    renderAR(ar);
    renderLeaderboard(stats, cur);
    renderAttention(buildAttention(cur, prev, stats, ar, fcGroups));
    window.__KPI = { cur, prev, stats, ar, jobs: JOBS }; // handy for poking around in devtools
  }

  const seg = $('period');
  seg.addEventListener('click', e => {
    const btn = e.target.closest('button[data-days]'); if (!btn) return;
    setDays(Number(btn.dataset.days)); btn.focus();
  });
  seg.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const opts = [7, 30, 90], i = opts.indexOf(DAYS), n = opts[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
    setDays(n); seg.querySelector(`[data-days="${n}"]`).focus(); e.preventDefault();
  });
  function setDays(n) {
    DAYS = n;
    try { localStorage.setItem('kpi-period', String(n)); } catch (e) { /* ignore */ }
    history.replaceState(null, '', '#' + n + 'd');
    render();
  }
  let rt, lastW = window.innerWidth;
  window.addEventListener('resize', () => { if (window.innerWidth === lastW) return; lastW = window.innerWidth; clearTimeout(rt); rt = setTimeout(render, 120); });
  window.addEventListener('scroll', hideTip, { passive: true });
  render();
})();
