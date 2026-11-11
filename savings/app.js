// Savings calculator: page wiring. The math lives in calc.js (window.SavingsCalc).
(function () {
  'use strict';
  const C = window.SavingsCalc;
  const $ = id => document.getElementById(id);
  const fmtNum = C.num, fmtMoney = C.money;

  const state = C.fromQuery(location.search);

  // ---------------------------------------------------------------- inputs
  C.FIELDS.forEach(f => {
    const box = $(f.id), range = $(f.id + '-range');
    if (!box || !range) return;
    box.min = f.min; box.max = f.max; box.step = f.step;
    range.min = f.min; range.max = f.smax; range.step = f.step;
    const show = v => { box.value = v; range.value = Math.min(v, f.smax); range.setAttribute('aria-valuetext', String(v)); };
    show(state[f.id]);
    range.addEventListener('input', () => { state[f.id] = parseFloat(range.value); box.value = state[f.id]; range.setAttribute('aria-valuetext', range.value); update(); });
    box.addEventListener('input', () => {
      if (box.value.trim() === '') return;              // let people clear the box while typing
      state[f.id] = C.normalize({ [f.id]: box.value })[f.id];
      range.value = Math.min(state[f.id], f.smax);
      update();
    });
    box.addEventListener('change', () => { show(state[f.id]); });  // snap back to the clamped value on blur
  });

  $('reset').addEventListener('click', () => {
    Object.assign(state, C.DEFAULTS);
    C.FIELDS.forEach(f => { $(f.id).value = f.def; $(f.id + '-range').value = Math.min(f.def, f.smax); });
    update();
  });

  // ---------------------------------------------------------------- output
  const grid = $('mod-grid');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DEMO = { M1: '/projects/work-order-intake/', M3: '/projects/thread-updates/', M4: '/projects/payment-proofing/', M5: '/case-study/' };

  function card(m) {
    const extra = m.id === 'M4' && m.mistakesYear ? `<p class="mod-extra">Includes about ${fmtMoney(m.mistakesYear)} a year in payment mistakes caught.</p>` : '';
    return `<article class="card mod">
      <div class="mod-top"><span class="mono">${m.id}</span><span class="badge est">Estimate</span></div>
      <h3>${esc(m.name)}</h3>
      <dl class="mod-nums">
        <div class="yr"><dt>$ / year</dt><dd class="hl">${fmtMoney(m.dollarsYear)}</dd></div>
        <div><dt>Hours / month</dt><dd>${fmtNum(m.hoursMonth)}</dd></div>
        <div><dt>$ / month</dt><dd>${fmtMoney(m.dollarsMonth)}</dd></div>
      </dl>
      ${extra}
      <p class="how"><b>How we got this:</b> ${esc(m.how)}</p>
      <a class="link" href="${DEMO[m.id]}">${m.id === 'M5' ? 'See the case study' : 'Try the demo'} →</a>
    </article>`;
  }
  const M2 = `<article class="card mod m2">
      <div class="mod-top"><span class="mono">M2</span><span class="badge risk">Risk reduction</span></div>
      <h3>Health check &amp; daily digest</h3>
      <p class="m2-lead">No dollar figure here, on purpose.</p>
      <p>M2 doesn't remove a task; it stops the expensive surprises. A watchdog flags an automation that quietly stopped within 5 minutes, failed work is held and retried instead of lost, and a 6:30 AM email lists overdue first calls and anything waiting on a person, before a vendor or customer has to chase you.</p>
      <a class="link" href="/projects/daily-digest/">Try the demo →</a>
    </article>`;

  let liveTimer = 0;
  function update() {
    const est = C.estimate(state);
    $('t-hours').textContent = fmtNum(est.total.hoursMonth);
    $('t-year').textContent = fmtMoney(est.total.dollarsYear);
    $('t-month').textContent = fmtMoney(est.total.dollarsMonth);
    $('mini-hours').textContent = fmtNum(est.total.hoursMonth);
    $('mini-year').textContent = fmtMoney(est.total.dollarsYear);
    grid.innerHTML = est.modules.map(card).join('') + M2;

    const url = shareUrl();
    const href = C.mailtoHref(est, url);
    $('cta-mail').href = href; $('cta-mail-2').href = href;

    // Announce totals once the person pauses, not on every slider step.
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      $('t-live').textContent = `Estimated savings: ${fmtNum(est.total.hoursMonth)} office hours a month, about ${fmtMoney(est.total.dollarsYear)} a year.`;
    }, 600);
  }

  function shareUrl() {
    const q = C.toQuery(state);
    return location.origin + location.pathname + (q ? '?' + q : '');
  }

  // ---------------------------------------------------------------- share
  $('share').addEventListener('click', async () => {
    const url = shareUrl();
    const status = $('share-status'), field = $('share-url');
    field.value = url;
    try {
      await navigator.clipboard.writeText(url);
      field.hidden = true;
      status.textContent = 'Link copied. Anyone who opens it sees these numbers.';
    } catch (e) {
      field.hidden = false; field.focus(); field.select();
      status.textContent = 'Copy this link:';
    }
  });

  // On narrow screens a small bar shows the total while you scroll through the inputs.
  // It hides once the real total panel (or the module cards) are on screen.
  if ('IntersectionObserver' in window) {
    const mini = $('mini-total'), seen = new Set();
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => e.isIntersecting ? seen.add(e.target) : seen.delete(e.target));
      mini.classList.toggle('show', seen.size === 0 && $('calc-form').getBoundingClientRect().top < innerHeight);
    });
    [$('total'), $('mod-grid'), document.querySelector('.page-hero'), document.querySelector('.assumptions'), document.querySelector('.contact')].forEach(el => el && io.observe(el));
  }

  update();
})();
