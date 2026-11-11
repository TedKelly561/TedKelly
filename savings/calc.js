// Savings calculator: the math. No DOM here, so it can be tested in Node:
//   const C = require('./calc.js'); C.estimate(C.DEFAULTS)
// In the browser it is window.SavingsCalc.
//
// Every figure is an ESTIMATE. The before/after times come from the module demos
// (M1 ~5 min retyping -> ~30 s review; M4 2 hours per pay run -> 5 minutes of
// exceptions; M3 follow-ups 4 -> 0 in the demo thread; M5 the case study's one-tier
// Zapier drop). Those are illustrative, so the reduction factors below are
// deliberately lower than the demos show.

(function (root) {
  'use strict';

  const WEEKS_PER_MONTH = 52 / 12;

  // The inputs, in the order they appear on the page. `key` is the short name used in the
  // share URL. min/max bound anything typed or pasted into the URL; smax is where the slider stops
  // (the number box still accepts up to max).
  const FIELDS = [
    { id: 'jobs',          key: 'j',  def: 150, min: 0, max: 5000,   smax: 1000, step: 10,  label: 'Work orders / jobs per month' },
    { id: 'retypeMin',     key: 'rm', def: 5,   min: 0, max: 30,     smax: 20, step: 0.5, label: 'Minutes retyping each emailed work order' },
    { id: 'statusPerWeek', key: 'sw', def: 30,  min: 0, max: 1000,   smax: 300, step: 5,   label: '"Where\'s my tech?" calls & emails per week' },
    { id: 'statusMin',     key: 'sm', def: 4,   min: 0, max: 30,     smax: 20, step: 0.5, label: 'Minutes each status call or email takes' },
    { id: 'payments',      key: 'p',  def: 20,  min: 0, max: 2000,   smax: 300, step: 5,   label: 'Contractor / tech payments per month' },
    { id: 'payMin',        key: 'pm', def: 6,   min: 0, max: 60,     smax: 30, step: 1,   label: 'Minutes to check each payment' },
    { id: 'mistakes',      key: 'me', def: 4,   min: 0, max: 200,    smax: 50, step: 1,   label: 'Payment mistakes per year' },
    { id: 'mistakeCost',   key: 'mc', def: 150, min: 0, max: 20000,  smax: 2000, step: 10,  label: 'Average cost of one payment mistake ($)' },
    { id: 'zapier',        key: 'z',  def: 100, min: 0, max: 10000,  smax: 1000, step: 10,  label: 'Zapier (or similar) bill per month ($)' },
    { id: 'rate',          key: 'r',  def: 25,  min: 0, max: 200,    smax: 80, step: 1,   label: 'Office labor cost per hour ($)' }
  ];

  const DEFAULTS = FIELDS.reduce((o, f) => (o[f.id] = f.def, o), {});

  // Conservative assumptions, shown on the page.
  const A = {
    m1ReviewMin: 0.5,      // ~30 s to review each ticket (the demo says "or none for clean ones")
    m1Coverage: 0.8,       // only 80% of orders assumed to go through intake; the rest stay manual
    m3Reduction: 0.5,      // half of status calls/emails assumed to go away (demo thread: 4 -> 0)
    m4TimeReduction: 0.75, // 75% of checking time saved (demo: 2 hours -> 5 minutes, ~96%)
    m4MistakeCatch: 0.5,   // half of payment mistakes assumed caught (demo: every double payment)
    m5Reduction: 0.4       // 40% of the automation bill assumed to move to scripts
  };

  // Turn anything (string, NaN, negative, huge) into a number inside the field's bounds.
  function clampField(f, v) {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    if (!isFinite(n)) return f.def;
    return Math.min(f.max, Math.max(f.min, n));
  }

  function normalize(input) {
    const src = input || {};
    const out = {};
    FIELDS.forEach(f => { out[f.id] = src[f.id] === undefined ? f.def : clampField(f, src[f.id]); });
    return out;
  }

  const round1 = n => Math.round(n * 10) / 10;
  const round0 = n => Math.round(n);

  // A module result: raw numbers for summing, rounded ones for display.
  function mod(id, name, hours, dollarsMonthExtra, rate, how) {
    const perMonth = hours * rate + dollarsMonthExtra;
    return {
      id, name, how,
      raw: { hoursMonth: hours, dollarsMonth: perMonth, dollarsYear: perMonth * 12 },
      hoursMonth: round1(hours),
      dollarsMonth: round0(perMonth),
      dollarsYear: round0(perMonth * 12)
    };
  }

  const money = n => '$' + round0(n).toLocaleString('en-US');
  const num = n => (Math.round(n * 10) / 10).toLocaleString('en-US');

  function estimate(input) {
    const v = normalize(input);
    const r = v.rate;

    // M1: email intake -> ticket
    const m1Saved = Math.max(0, v.retypeMin - A.m1ReviewMin);
    const m1Hours = v.jobs * A.m1Coverage * m1Saved / 60;
    const m1 = mod('M1', 'Email intake → ticket', m1Hours, 0, r,
      `${num(v.jobs)} orders × 80% handled × (${num(v.retypeMin)} min retyping − ~30 s review) ÷ 60 × ${money(r)}/hr. ` +
      'Assumes intake cuts retyping to a ~30-second check, as in the M1 demo, and that 1 in 5 orders still needs a person.');

    // M3: status updates on the original thread
    const m3Contacts = v.statusPerWeek * WEEKS_PER_MONTH;
    const m3Hours = m3Contacts * A.m3Reduction * v.statusMin / 60;
    const m3 = mod('M3', 'Status updates on the original thread', m3Hours, 0, r,
      `${num(v.statusPerWeek)}/week × 4.33 weeks × 50% fewer × ${num(v.statusMin)} min ÷ 60 × ${money(r)}/hr. ` +
      'Assumes only half of "where\'s my tech?" contacts stop once updates post automatically (the M3 demo thread went from 4 follow-ups to 0).');

    // M4: payment proofing
    const m4Hours = v.payments * v.payMin * A.m4TimeReduction / 60;
    const m4Mistakes = v.mistakes * v.mistakeCost * A.m4MistakeCatch / 12;
    const m4 = mod('M4', 'Payment proofing', m4Hours, m4Mistakes, r,
      `${num(v.payments)} payments × ${num(v.payMin)} min × 75% ÷ 60 × ${money(r)}/hr, plus ${num(v.mistakes)} mistakes/yr × ${money(v.mistakeCost)} × 50% caught. ` +
      'The M4 demo shows 2 hours per pay run cut to 5 minutes of exceptions; we count 75% of the time and half the mistakes.');
    m4.mistakesYear = round0(m4Mistakes * 12);

    // M5: moving off a growing Zapier bill
    const m5Dollars = v.zapier * A.m5Reduction;
    const m5 = mod('M5', 'Move off a growing Zapier bill', 0, m5Dollars, r,
      `${money(v.zapier)}/month × 40%. Assumes 40% of the bill moves to scripts that cost nothing per run ` +
      '(the case study dropped one Zapier plan tier, about $60 a month).');

    const modules = [m1, m3, m4, m5];
    const tH = modules.reduce((s, m) => s + m.raw.hoursMonth, 0);
    const tM = modules.reduce((s, m) => s + m.raw.dollarsMonth, 0);

    return {
      inputs: v,
      modules,
      total: {
        hoursMonth: round1(tH),
        dollarsMonth: round0(tM),
        dollarsYear: round0(tM * 12)
      }
    };
  }

  // Query string <-> inputs. Only values that differ from the defaults are written.
  function toQuery(input) {
    const v = normalize(input);
    const p = [];
    FIELDS.forEach(f => { if (v[f.id] !== f.def) p.push(f.key + '=' + encodeURIComponent(String(v[f.id]))); });
    return p.join('&');
  }

  function fromQuery(qs) {
    const out = {};
    String(qs || '').replace(/^\?/, '').split('&').forEach(pair => {
      if (!pair) return;
      const i = pair.indexOf('=');
      const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      const val = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      const f = FIELDS.find(x => x.key === k);
      if (f) out[f.id] = clampField(f, val);
    });
    return normalize(out);
  }

  // Plain-text email body for the "Book a free call" link.
  function emailBody(est, shareUrl) {
    const v = est.inputs;
    const L = [
      'Hi Ted,',
      '',
      'I ran the savings calculator on tedkelly.dev and would like a free 20-minute call.',
      '',
      'My numbers:',
      `- Work orders per month: ${num(v.jobs)}`,
      `- Minutes retyping each: ${num(v.retypeMin)}`,
      `- Status calls/emails per week: ${num(v.statusPerWeek)} at ${num(v.statusMin)} min each`,
      `- Contractor payments per month: ${num(v.payments)} at ${num(v.payMin)} min to check`,
      `- Payment mistakes per year: ${num(v.mistakes)} at ${money(v.mistakeCost)} each`,
      `- Zapier (or similar) bill: ${money(v.zapier)}/month`,
      `- Office labor cost: ${money(v.rate)}/hr`,
      '',
      'Calculator estimate (not a promise):'
    ];
    est.modules.forEach(m => {
      L.push(`- ${m.id} ${m.name}: ${num(m.hoursMonth)} h/month, ${money(m.dollarsYear)}/year`);
    });
    L.push(`- Total: ${num(est.total.hoursMonth)} h/month, about ${money(est.total.dollarsYear)}/year`);
    if (shareUrl) { L.push('', 'Link to these numbers: ' + shareUrl); }
    L.push('', 'The part that hurts most right now:', '');
    return L.join('\n');
  }

  const MAIL_TO = 'ted@tedkelly.dev';
  const MAIL_SUBJECT = 'Savings estimate — free call';

  function mailtoHref(est, shareUrl) {
    const head = 'mailto:' + MAIL_TO + '?subject=' + encodeURIComponent(MAIL_SUBJECT) + '&body=';
    let href = head + encodeURIComponent(emailBody(est, shareUrl));
    // Some mail apps truncate long mailto links; drop the share link first if we're too long.
    if (href.length > 1800) href = head + encodeURIComponent(emailBody(est, ''));
    return href;
  }

  const api = { FIELDS, DEFAULTS, ASSUMPTIONS: A, WEEKS_PER_MONTH, normalize, estimate, toQuery, fromQuery, emailBody, mailtoHref, MAIL_TO, MAIL_SUBJECT, money, num };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SavingsCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
