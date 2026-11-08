/*
 * "Ask Ted's assistant" chat widget for tedkelly.dev. No build step, no dependencies.
 *
 *   <script src="/assets/assistant.js" data-endpoint="https://<worker>.workers.dev/chat" defer></script>
 *
 * It loads /assets/assistant.css next to itself, adds a floating button, and talks
 * to the Worker in assistant-worker/. The conversation lives in memory, mirrored to
 * sessionStorage (this tab only, cleared when the tab closes) so it survives moving
 * between pages. Nothing is sent anywhere except the Worker, and the Worker stores nothing.
 */
(function () {
  'use strict';
  if (window.__tedAssistant) return;
  window.__tedAssistant = true;

  var script = document.currentScript || document.querySelector('script[src*="assistant.js"][data-endpoint]');
  var ENDPOINT = (script && script.getAttribute('data-endpoint')) || '';
  var EMAIL = 'ted@tedkelly.dev';
  var MAX_TURNS = 12;
  var MAX_CHARS = 1000;
  var MAILTO_MAX = 1800;
  var STORE_KEY = 'tka-chat-v1';
  var GREETING = "Hi, I'm Ted's assistant (AI). Ask me how automation could work in your shop.";
  var FALLBACK = "Sorry, I can't reach the assistant right now. You can email Ted directly at " + EMAIL +
    ', or use the "Book a free 20-minute call" button below.';
  var SUGGESTIONS = [
    'What would you build first for a 10-tech HVAC shop?',
    'How do you keep automations from breaking things?',
    'What does it cost to run?'
  ];

  // ---------- state ----------
  var messages = []; // [{ role: 'user' | 'assistant', content: string }]
  var busy = false;
  try {
    var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    if (saved && Array.isArray(saved.messages)) {
      messages = saved.messages.filter(function (m) {
        return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
      });
    }
  } catch (e) { /* storage blocked: memory only */ }
  function save() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ messages: messages })); } catch (e) { /* ignore */ }
  }
  function userTurns() {
    var n = 0;
    for (var i = 0; i < messages.length; i++) if (messages[i].role === 'user') n++;
    return n;
  }

  // ---------- DOM helpers ----------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k]; // only used for our own static SVG
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
  var ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';

  // Plain text in, safe DOM out. Only tedkelly.dev links and Ted's email become links.
  var LINK_RE = /(https?:\/\/(?:www\.)?tedkelly\.dev(?:\/[^\s<>"')\]]*)?|ted@tedkelly\.dev)/g;
  function renderText(node, text) {
    node.textContent = '';
    text = String(text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^#{1,4}\s+/gm, '');
    var last = 0, m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(text))) {
      var raw = m[0], trail = '';
      while (/[.,;:!?]$/.test(raw)) { trail = raw.slice(-1) + trail; raw = raw.slice(0, -1); }
      node.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      if (raw === EMAIL) { a.href = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('Free 20-minute call'); }
      else { a.href = raw; }
      a.textContent = raw;
      node.appendChild(a);
      node.appendChild(document.createTextNode(trail));
      last = m.index + m[0].length;
    }
    node.appendChild(document.createTextNode(text.slice(last)));
  }

  // ---------- mailto ----------
  function buildMailto() {
    var qs = messages.filter(function (m) { return m.role === 'user'; }).map(function (m) {
      return m.content.replace(/\s+/g, ' ').trim();
    });
    var subject = 'Free 20-minute call';
    function make(list, cap, dropped) {
      var lines = [
        'Hi Ted,',
        '',
        "I'd like to book a free 20-minute call.",
        '',
        'My business:',
        'Best time to reach me:',
        ''
      ];
      if (list.length) {
        lines.push("What I asked your site assistant:");
        if (dropped) lines.push('(' + dropped + ' earlier question' + (dropped > 1 ? 's' : '') + ' left out)');
        list.forEach(function (q) { lines.push('- ' + (q.length > cap ? q.slice(0, cap - 1).trim() + '…' : q)); });
        lines.push('');
      }
      return 'mailto:' + EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(lines.join('\r\n'));
    }
    var caps = [300, 200, 120, 80];
    for (var i = 0; i < caps.length; i++) {
      var url = make(qs, caps[i], 0);
      if (url.length <= MAILTO_MAX) return url;
    }
    for (var d = 1; d <= qs.length; d++) {
      var u = make(qs.slice(d), 80, d);
      if (u.length <= MAILTO_MAX) return u;
    }
    return make([], 80, 0);
  }

  // ---------- build the UI ----------
  var root = el('div', { 'class': 'tka-root' });
  var launch = el('button', { type: 'button', 'class': 'tka-launch', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'tka-panel' });
  launch.innerHTML = ICON_CHAT;
  launch.appendChild(el('span', { text: "Ask Ted's assistant" }));

  var closeBtn = el('button', { type: 'button', 'class': 'tka-close', 'aria-label': 'Close chat', html: ICON_X });
  var head = el('div', { 'class': 'tka-head' }, [
    el('div', { 'class': 'tka-avatar', 'aria-hidden': 'true', text: 'TK' }),
    el('div', { 'class': 'tka-title' }, [
      (function () { var h = el('h2', { id: 'tka-title', text: "Ted's assistant" }); h.appendChild(el('span', { 'class': 'tka-badge', text: 'AI' })); return h; })(),
      el('p', { text: 'Answers from tedkelly.dev' })
    ]),
    closeBtn
  ]);
  var log = el('div', { 'class': 'tka-log', role: 'log', 'aria-label': 'Conversation', tabindex: '0' });
  var live = el('div', { 'class': 'tka-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  var input = el('textarea', { 'class': 'tka-input', id: 'tka-input', rows: '1', maxlength: String(MAX_CHARS), placeholder: 'Ask about your shop…', 'aria-label': 'Your question', autocomplete: 'off' });
  var send = el('button', { type: 'submit', 'class': 'tka-send', 'aria-label': 'Send', html: ICON_SEND });
  var form = el('form', { 'class': 'tka-form' }, [input, send]);
  var count = el('div', { 'class': 'tka-count', 'aria-live': 'polite', hidden: '' });
  var book = el('a', { 'class': 'tka-book', href: buildMailto() });
  book.innerHTML = ICON_CAL;
  book.appendChild(el('span', { text: 'Book a free 20-minute call' }));
  var foot = el('div', { 'class': 'tka-foot' }, [
    book,
    el('p', { 'class': 'tka-small', text: 'AI assistant. Answers come from tedkelly.dev and may be imperfect. Nothing you type is stored.' })
  ]);
  var panel = el('div', { 'class': 'tka-panel', id: 'tka-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tka-title', hidden: '' }, [head, log, live, form, count, foot]);
  root.appendChild(launch);
  root.appendChild(panel);

  // ---------- rendering ----------
  var chips = null;
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  function addBubble(role, text, extraClass) {
    var b = el('div', { 'class': 'tka-msg ' + (role === 'user' ? 'tka-user' : 'tka-bot') + (extraClass ? ' ' + extraClass : '') });
    if (role !== 'user') b.appendChild(el('span', { 'class': 'tka-sr', text: "Ted's assistant: " }));
    var body = el('span');
    b.appendChild(body);
    renderText(body, text);
    log.appendChild(b);
    scrollDown();
    return body;
  }
  function renderAll() {
    log.textContent = '';
    addBubble('assistant', GREETING);
    if (!messages.length) {
      chips = el('div', { 'class': 'tka-chips', role: 'group', 'aria-label': 'Suggested questions' });
      SUGGESTIONS.forEach(function (q) {
        var c = el('button', { type: 'button', 'class': 'tka-chip', text: q });
        c.addEventListener('click', function () { ask(q); });
        chips.appendChild(c);
      });
      log.appendChild(chips);
    }
    messages.forEach(function (m) { addBubble(m.role, m.content); });
    if (userTurns() >= MAX_TURNS) addLimitNote();
    updateControls();
  }
  function addLimitNote() {
    addBubble('assistant', "That's the limit for this chat. To keep going, book a free 20-minute call with Ted using the button below.");
  }
  function updateControls() {
    var atLimit = userTurns() >= MAX_TURNS;
    input.disabled = atLimit;
    input.placeholder = atLimit ? 'Chat limit reached' : 'Ask about your shop…';
    send.disabled = busy || atLimit || !input.value.trim();
    book.href = buildMailto();
    var len = input.value.length;
    if (len > MAX_CHARS - 200) {
      count.hidden = false;
      count.textContent = len + ' / ' + MAX_CHARS;
      count.className = 'tka-count' + (len >= MAX_CHARS ? ' tka-over' : '');
    } else count.hidden = true;
  }
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 120) + 'px';
  }
  function announce(text) {
    live.textContent = '';
    setTimeout(function () { live.textContent = "Ted's assistant: " + text; }, 30);
  }

  // ---------- talking to the Worker ----------
  function showFallback(bubbleBody, text) {
    var b = bubbleBody.parentNode;
    b.className += ' tka-error';
    renderText(bubbleBody, text || FALLBACK);
    announce(text || FALLBACK);
  }

  function ask(question) {
    question = String(question || '').trim().slice(0, MAX_CHARS);
    if (!question || busy || userTurns() >= MAX_TURNS) return;
    busy = true;
    if (chips) {
      var chipHadFocus = chips.contains(document.activeElement);
      chips.remove();
      chips = null;
      if (chipHadFocus) input.focus();
    }
    messages.push({ role: 'user', content: question });
    save();
    addBubble('user', question);
    input.value = '';
    autoGrow();
    updateControls();

    // Typing indicator, replaced by streamed text.
    var bubble = el('div', { 'class': 'tka-msg tka-bot', 'aria-busy': 'true' });
    bubble.appendChild(el('span', { 'class': 'tka-sr', text: "Ted's assistant is typing" }));
    var body = el('span');
    var dots = el('span', { 'class': 'tka-typing', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]);
    body.appendChild(dots);
    bubble.appendChild(body);
    log.appendChild(bubble);
    scrollDown();

    var reply = '';
    function setReply(t) {
      reply = t;
      if (bubble.firstChild && bubble.firstChild.className === 'tka-sr') bubble.firstChild.textContent = "Ted's assistant: ";
      renderText(body, reply);
      scrollDown();
    }
    function finish(errorText) {
      busy = false;
      bubble.removeAttribute('aria-busy');
      if (errorText || !reply.trim()) {
        // The unanswered question stays in the history (it's still what they want to
        // ask Ted, and it goes in the email summary). The Worker merges consecutive
        // user messages, so the next request is still valid.
        showFallback(body, errorText);
      } else {
        messages.push({ role: 'assistant', content: reply });
        save();
        announce(reply);
      }
      if (userTurns() >= MAX_TURNS) addLimitNote();
      updateControls();
      if (!panel.hidden && !panel.contains(document.activeElement)) (input.disabled ? book : input).focus();
    }

    if (!ENDPOINT || /REPLACE/.test(ENDPOINT) || typeof fetch !== 'function') {
      setTimeout(function () { finish(); }, 400);
      return;
    }

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 45000);
    fetch(ENDPOINT, {
      method: 'POST',
      // text/plain keeps this a "simple" CORS request (no preflight); the Worker accepts it.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ messages: messages }),
      signal: ctrl ? ctrl.signal : undefined,
      credentials: 'omit',
      cache: 'no-store'
    }).then(function (res) {
      var type = res.headers.get('Content-Type') || '';
      if (!res.ok || type.indexOf('text/event-stream') === -1) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          // Show the Worker's own friendly message for limits; the generic fallback otherwise.
          var friendly = j && j.message && (res.status === 429 || res.status === 413) ? j.message + ' You can also email Ted at ' + EMAIL + '.' : null;
          finish(friendly || FALLBACK);
        });
      }
      if (!res.body || !res.body.getReader) {
        return res.text().then(function (t) { handleChunk(t, true); });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var errored = null;
      var done = false;
      function handleChunk(chunk, final) {
        buf += chunk;
        var parts = buf.split('\n\n');
        buf = final ? '' : parts.pop();
        parts.forEach(function (p) {
          var line = p.split('\n').filter(function (l) { return l.indexOf('data: ') === 0; }).map(function (l) { return l.slice(6); }).join('\n');
          if (!line) return;
          var ev;
          try { ev = JSON.parse(line); } catch (e) { return; }
          if (ev.type === 'text' && typeof ev.text === 'string') setReply(reply + ev.text);
          else if (ev.type === 'replace' && typeof ev.text === 'string') setReply(ev.text);
          else if (ev.type === 'error') errored = ev.message || FALLBACK;
          else if (ev.type === 'done') done = true;
        });
        if (final) finish(errored || (!done && !reply ? FALLBACK : null));
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { handleChunk(decoder.decode(), true); return; }
          handleChunk(decoder.decode(r.value, { stream: true }), false);
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (busy) finish(reply ? null : FALLBACK);
    }).then(function () { clearTimeout(timer); });
  }

  // ---------- open / close / keyboard ----------
  function focusables() {
    return Array.prototype.filter.call(
      panel.querySelectorAll('button, [href], textarea, [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; }
    );
  }
  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    root.classList.add('tka-open');
    document.documentElement.classList.add('tka-lock');
    launch.setAttribute('aria-expanded', 'true');
    renderAll();
    setTimeout(function () { (input.disabled ? closeBtn : input).focus(); scrollDown(); }, 0);
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    root.classList.remove('tka-open');
    document.documentElement.classList.remove('tka-lock');
    launch.setAttribute('aria-expanded', 'false');
    launch.focus();
  }
  launch.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Keep focus inside the dialog if something outside grabs it.
  document.addEventListener('focusin', function (e) {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== launch) { var f = focusables(); if (f[0]) f[0].focus(); }
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  input.addEventListener('input', function () { autoGrow(); updateControls(); });
  book.addEventListener('focus', function () { book.href = buildMailto(); });
  book.addEventListener('mousedown', function () { book.href = buildMailto(); });

  // ---------- mount (after the stylesheet, so there's no unstyled flash) ----------
  function mount() {
    if (root.parentNode) return;
    document.body.appendChild(root);
  }
  var cssHref = script && script.src ? script.src.replace(/assistant\.js(\?.*)?$/, 'assistant.css$1') : '/assets/assistant.css';
  var existing = document.querySelector('link[href$="assistant.css"]');
  function start() {
    if (existing) return mount();
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssHref;
    link.onload = mount;
    link.onerror = function () { /* no styles: don't show a broken widget */ };
    document.head.appendChild(link);
    setTimeout(function () { if (link.sheet) mount(); }, 3000);
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  // For tests and debugging.
  window.__tedAssistantDebug = { buildMailto: buildMailto, open: open, close: close };
})();
