// Site-wide settings and small helpers for tedkelly.dev.
//
// Two settings to fill in (leave a value empty to keep that feature off):
//   BOOKING_URL         your Google Calendar booking page. When set, every "free call" button
//                       opens it, and the email address stays as a second option.
//   CF_ANALYTICS_TOKEN  the Cloudflare Web Analytics token for tedkelly.dev (no cookies,
//                       no personal data). When set, the beacon loads on every page.
(function () {
  var BOOKING_URL = '';
  var CF_ANALYTICS_TOKEN = '';

  // ---------- Phone menu ----------
  var header = document.querySelector('.nav');
  var btn = document.querySelector('.menu-btn');
  var nav = document.getElementById('main-nav');
  if (header && btn && nav) {
    var setOpen = function (open) {
      header.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    btn.addEventListener('click', function () { setOpen(!header.classList.contains('open')); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && header.classList.contains('open')) { setOpen(false); btn.focus(); }
    });
    document.addEventListener('click', function (e) {
      if (header.classList.contains('open') && !header.contains(e.target)) setOpen(false);
    });
    // Close it if the window grows past the phone layout.
    window.addEventListener('resize', function () { if (window.innerWidth > 640) setOpen(false); });
  }

  // ---------- Booking ----------
  if (BOOKING_URL) {
    document.querySelectorAll('a[data-book]').forEach(function (a) {
      var mail = a.getAttribute('href');
      a.href = BOOKING_URL;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Book a free 20-minute call';
      if (a.getAttribute('data-book') === 'with-email') {
        var alt = document.createElement('a');
        alt.className = 'btn ghost';
        alt.href = mail;
        alt.textContent = 'Or email ted@tedkelly.dev';
        a.insertAdjacentElement('afterend', alt);
      }
    });
    // Extra booking buttons that stay hidden until there is a booking page (savings calculator).
    document.querySelectorAll('a[data-book-extra]').forEach(function (a) {
      a.href = BOOKING_URL;
      a.target = '_blank';
      a.rel = 'noopener';
      a.hidden = false;
    });
    // Email buttons that carry extra details (the savings estimate) stay, as the second option.
    document.querySelectorAll('a[data-book-relabel]').forEach(function (a) {
      a.textContent = a.getAttribute('data-book-relabel');
      a.classList.add('ghost');
    });
  }

  // ---------- Visit counts ----------
  if (CF_ANALYTICS_TOKEN) {
    var s = document.createElement('script');
    s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: CF_ANALYTICS_TOKEN }));
    document.head.appendChild(s);
  }
})();
