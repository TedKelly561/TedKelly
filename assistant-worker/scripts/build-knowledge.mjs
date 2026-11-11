#!/usr/bin/env node
// Regenerates src/knowledge.ts (the assistant's system prompt) from the site.
//
//   node scripts/build-knowledge.mjs        (or: npm run knowledge)
//
// It reads the hand-written rules in scripts/instructions.md, the <main> text of
// the site's pages, and the visitor-facing sections of the module READMEs, and
// writes one frozen string. Run it whenever the site content changes, then
// redeploy. The output is deterministic (no timestamps), so the prompt cache
// stays valid between deploys that don't change the content.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(here, '..');
const siteRoot = path.resolve(workerDir, '..');
const SITE = 'https://tedkelly.dev';

const PAGES = [
  { file: 'index.html', url: `${SITE}/`, title: 'Home page' },
  { file: 'work-with-me/index.html', url: `${SITE}/work-with-me/`, title: 'Work with me (packages, how it works, FAQ)' },
  { file: 'safety/index.html', url: `${SITE}/safety/`, title: 'Safety method' },
  { file: 'case-study/index.html', url: `${SITE}/case-study/`, title: 'Case study (M5: moving off a growing Zapier bill)' },
  { file: 'hire/index.html', url: `${SITE}/hire/`, title: 'Hire me (for employers: roles Ted is open to, experience, tools)' },
  { file: 'savings/index.html', url: `${SITE}/savings/`, title: 'Savings calculator (visitor enters their own numbers; conservative estimate, no prices)' },
];

const READMES = [
  { file: 'projects/work-order-intake/README.md', url: `${SITE}/projects/work-order-intake/`, title: 'M1 Email intake to ticket (Work Order Intake demo)' },
  { file: 'projects/daily-digest/README.md', url: `${SITE}/projects/daily-digest/`, title: 'M2 Health check and daily digest demo' },
  { file: 'projects/thread-updates/README.md', url: `${SITE}/projects/thread-updates/`, title: 'M3 Status updates on the original thread demo' },
  { file: 'projects/payment-proofing/README.md', url: `${SITE}/projects/payment-proofing/`, title: 'M4 Payment proofing demo' },
  { file: 'projects/quote-builder/README.md', url: `${SITE}/projects/quote-builder/`, title: 'Toolkit demo: Quote Builder' },
  { file: 'projects/dispatch-board/README.md', url: `${SITE}/projects/dispatch-board/`, title: 'Toolkit demo: Dispatch Board' },
  { file: 'projects/kpi-dashboard/README.md', url: `${SITE}/projects/kpi-dashboard/`, title: "Toolkit demo: Owner's KPI Dashboard" },
  { file: 'projects/README.md', url: `${SITE}/projects/`, title: 'Service Business Toolkit (all demos)' },
];

// README sections written for developers, not for shop owners.
const SKIP_SECTIONS = /^(for developers|how it is built|built with)\b/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', mdash: '—', ndash: '–', hellip: '…', copy: '©' };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function absUrl(href) {
  if (!href || href.startsWith('#') || href.startsWith('mailto:')) return null;
  if (/^https?:\/\//.test(href)) return href;
  if (href.startsWith('/')) return SITE + href;
  return null;
}

export function htmlToText(html) {
  let s = html;
  const main = s.match(/<main[\s\S]*?<\/main>/i);
  s = main ? main[0] : s;
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/\s+/g, ' '); // HTML whitespace collapses; block tags add newlines below
  // Links: keep the text and add the absolute URL so the model can cite pages.
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
    const href = (attrs.match(/href="([^"]*)"/i) || [])[1];
    const url = absUrl(href);
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!url) return ` ${text} `;
    return ` ${text} (${url}) `;
  });
  s = s
    .replace(/<h([1-4])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-4]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|header|footer)>/gi, '\n')
    .replace(/<(b|strong)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  s = decode(s);
  return tidy(s);
}

function tidy(s) {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/ ([,.;:!?)])/g, '$1').replace(/\( /g, '(').trim())
    // drop blank lines that are doubled, or that sit between two list items
    .filter((l, i, a) => l !== '' || ((a[i - 1] ?? '') !== '' && !(/^- /.test(a[i - 1]) && /^- /.test(a[i + 1] ?? ''))))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function readmeToText(md) {
  const out = [];
  let skipping = false;
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) { inFence = !inFence; if (!skipping) continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h && !inFence) {
      skipping = h[1].length >= 2 && SKIP_SECTIONS.test(h[2]);
      if (skipping) continue;
    }
    if (skipping || inFence) continue;
    if (/^!\[/.test(line.trim())) continue; // images / GIFs
    out.push(
      line
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, href) => {
          const url = absUrl(href);
          return url ? `${t} (${url})` : t;
        })
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1'),
    );
  }
  return tidy(out.join('\n'));
}

function build() {
  const instructions = readFileSync(path.join(here, 'instructions.md'), 'utf8').trim();
  const parts = [];
  for (const p of PAGES) {
    const text = htmlToText(readFileSync(path.join(siteRoot, p.file), 'utf8'));
    parts.push(`<page title="${p.title}" url="${p.url}">\n${text}\n</page>`);
  }
  for (const r of READMES) {
    const text = readmeToText(readFileSync(path.join(siteRoot, r.file), 'utf8'));
    parts.push(`<page title="${r.title}" url="${r.url}">\n${text}\n</page>`);
  }
  const notes = [
    'Module numbering used on the site: M1 = Email intake to ticket (live demo), M2 = Health check and daily digest (live demo), M3 = Status updates on the original thread (live demo), M4 = Payment proofing (live demo), M5 = Move off a growing Zapier bill (the case study). The Service Business Toolkit demos (Work Order Intake, Quote Builder, Dispatch Board, Owner\'s Dashboard) are extra demos on the fictional Summit Home Services.',
    'Contact: ted@tedkelly.dev. The first step is a free 20-minute call.',
  ];
  const content = `<site_content>\n${notes.join('\n')}\n\n${parts.join('\n\n')}\n</site_content>`;
  const prompt = `${instructions}\n\n${content}\n\nAnswer only from the site content above and follow the rules at the top.`;
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 12);

  const ts = `// GENERATED by scripts/build-knowledge.mjs from the tedkelly.dev site content
// and scripts/instructions.md. Do not edit by hand: edit those, then run
// \`npm run knowledge\`.

export const KNOWLEDGE_VERSION = ${JSON.stringify(hash)};

export const SYSTEM_PROMPT: string = ${JSON.stringify(prompt)};
`;
  writeFileSync(path.join(workerDir, 'src', 'knowledge.ts'), ts);
  console.log(`Wrote src/knowledge.ts: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens), version ${hash}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
