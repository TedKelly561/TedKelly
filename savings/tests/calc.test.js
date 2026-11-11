// Node tests for the savings math. Run from the savings folder:  node tests/calc.test.js
// No test framework needed. Exits with code 1 on the first failure.
'use strict';
const C = require('../calc.js');

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('  FAIL -', msg); process.exit(1); }
  passed++; console.log('  ok -', msg);
}
const section = s => console.log('\n' + s);
const byId = (est, id) => est.modules.find(m => m.id === id);
const allZero = Object.fromEntries(C.FIELDS.map(f => [f.id, 0]));

section('Defaults');
{
  const e = C.estimate(C.DEFAULTS);
  ok(e.inputs.rate === 25, 'default labor cost is $25/hr');
  ok(byId(e, 'M1').hoursMonth === 9 && byId(e, 'M1').dollarsYear === 2700, 'M1: 150 × 80% × 4.5 min = 9 h/month, $2,700/year');
  ok(byId(e, 'M3').hoursMonth === 4.3 && byId(e, 'M3').dollarsMonth === 108 && byId(e, 'M3').dollarsYear === 1300, 'M3: 30/wk × 4.33 × 50% × 4 min = 4.3 h, $108/month, $1,300/year');
  ok(byId(e, 'M4').hoursMonth === 1.5 && byId(e, 'M4').dollarsMonth === 63 && byId(e, 'M4').dollarsYear === 750, 'M4: 1.5 h ($37.50) + $25/month of mistakes = $63/month, $750/year');
  ok(byId(e, 'M4').mistakesYear === 300, 'M4: 4 mistakes × $150 × 50% = $300/year');
  ok(byId(e, 'M5').hoursMonth === 0 && byId(e, 'M5').dollarsMonth === 40 && byId(e, 'M5').dollarsYear === 480, 'M5: $100 × 40% = $40/month, $480/year, no hours');
  ok(e.total.hoursMonth === 14.8 && e.total.dollarsMonth === 436 && e.total.dollarsYear === 5230, 'total: 14.8 h/month, $436/month, $5,230/year');
  ok(C.estimate().total.dollarsYear === 5230 && C.estimate({}).total.dollarsYear === 5230, 'no input at all uses the defaults');
  ok(e.modules.every(m => /×/.test(m.how) && m.how.length > 40), 'every module explains its formula');
}

section('Zeros');
{
  const e = C.estimate(allZero);
  ok(e.total.hoursMonth === 0 && e.total.dollarsMonth === 0 && e.total.dollarsYear === 0, 'all zeros → $0 and 0 h');
  ok(e.modules.every(m => m.hoursMonth === 0 && m.dollarsYear === 0), 'every module is zero');
  const noRate = C.estimate(Object.assign({}, C.DEFAULTS, { rate: 0, zapier: 0, mistakes: 0 }));
  ok(noRate.total.hoursMonth === 14.8 && noRate.total.dollarsYear === 0, '$0/hr still shows hours saved but no dollars');
  const fast = C.estimate(Object.assign({}, C.DEFAULTS, { retypeMin: 0.25 }));
  ok(byId(fast, 'M1').hoursMonth === 0, 'retyping already under 30 s → M1 saves nothing (never negative)');
}

section('Large values and bad input');
{
  const big = Object.fromEntries(C.FIELDS.map(f => [f.id, 1e9]));
  const e = C.estimate(big);
  ok(e.inputs.jobs === 5000 && e.inputs.rate === 200 && e.inputs.zapier === 10000, 'huge values clamp to each field\'s max');
  ok(Number.isFinite(e.total.dollarsYear) && e.total.dollarsYear > 0, 'clamped total is a finite number');
  const neg = C.estimate(Object.fromEntries(C.FIELDS.map(f => [f.id, -50])));
  ok(neg.total.dollarsYear === 0, 'negative values clamp to 0');
  const junk = C.estimate({ jobs: 'abc', rate: NaN, zapier: '$1,200' });
  ok(junk.inputs.jobs === 150 && junk.inputs.rate === 25 && junk.inputs.zapier === 1200, 'junk falls back to the default; "$1,200" reads as 1200');
  const e2 = C.estimate(Object.assign({}, C.DEFAULTS, { jobs: 1000, retypeMin: 8 }));
  ok(byId(e2, 'M1').hoursMonth === 100 && byId(e2, 'M1').dollarsYear === 30000, '1,000 orders × 80% × 7.5 min = 100 h/month, $30,000/year');
}

section('Rounding');
{
  const e = C.estimate(Object.assign({}, allZero, { statusPerWeek: 7, statusMin: 3, rate: 33 }));
  // 7 × 52/12 × 0.5 × 3 / 60 = 0.758333 h → 0.8; × $33 = $25.025 → $25; × 12 = $300.30 → $300
  const m3 = byId(e, 'M3');
  ok(m3.hoursMonth === 0.8, 'hours round to one decimal (0.758 → 0.8)');
  ok(m3.dollarsMonth === 25 && m3.dollarsYear === 300, 'dollars round to whole dollars, yearly from the unrounded monthly');
  const t = C.estimate(Object.assign({}, C.DEFAULTS, { rate: 27 }));
  const raw = t.modules.reduce((s, m) => s + m.raw.dollarsMonth, 0);
  ok(t.total.dollarsYear === Math.round(raw * 12), 'total is rounded once from unrounded module values');
  ok(t.modules.every(m => Number.isInteger(m.dollarsMonth) && Number.isInteger(m.dollarsYear)), 'module dollars are whole numbers');
  ok(C.money(5230) === '$5,230' && C.num(14.83) === '14.8', 'formatting: $5,230 and 14.8');
}

section('Share URL round trip');
{
  ok(C.toQuery(C.DEFAULTS) === '', 'defaults give an empty query string');
  const mine = Object.assign({}, C.DEFAULTS, { jobs: 320, retypeMin: 7.5, zapier: 0, rate: 31 });
  const q = C.toQuery(mine);
  ok(q === 'j=320&rm=7.5&z=0&r=31', 'only changed values are written: ' + q);
  ok(JSON.stringify(C.fromQuery('?' + q)) === JSON.stringify(C.normalize(mine)), 'fromQuery(toQuery(x)) restores x');
  ok(C.fromQuery('?j=999999&r=-4&x=1&rm=').jobs === 5000 && C.fromQuery('?r=-4').rate === 0 && C.fromQuery('?rm=').retypeMin === 5, 'bad URL values are clamped or ignored');
}

section('Email');
{
  const e = C.estimate(C.DEFAULTS);
  const body = C.emailBody(e, 'https://tedkelly.dev/savings/?j=150');
  ok(/Work orders per month: 150/.test(body) && /Office labor cost: \$25\/hr/.test(body), 'body lists the inputs');
  ok(/Total: 14\.8 h\/month, about \$5,230\/year/.test(body), 'body has the total');
  ok(/not a promise/.test(body), 'body says it is an estimate');
  const href = C.mailtoHref(e, 'https://tedkelly.dev/savings/?j=150');
  ok(href.startsWith('mailto:ted@tedkelly.dev?subject=Savings%20estimate%20%E2%80%94%20free%20call&body='), 'mailto has the right address and subject');
  ok(href.length < 1800, 'mailto is under 1,800 characters (' + href.length + ')');
  const huge = C.mailtoHref(C.estimate(Object.fromEntries(C.FIELDS.map(f => [f.id, f.max]))), 'https://tedkelly.dev/savings/?' + 'x'.repeat(900));
  ok(huge.length < 1800 && !/xxxx/.test(huge), 'an over-long link is dropped to stay under 1,800 characters');
}

console.log(`\n${passed} passed`);
