// Headless-Chromium test of the chat widget on the real site pages.
//
//   CHROME_PATH=/path/to/chrome npm run test:widget       (SCREENSHOTS=dir to save screenshots)
//
// It serves the site from the repo root, rewrites the widget's data-endpoint,
// and runs the real Worker under `wrangler dev` against a mock Anthropic API.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startMockAnthropic } from './mock-anthropic.mjs';
import { startWorker } from './dev-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(here, '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const SHOTS = process.env.SCREENSHOTS || '';
const PLACEHOLDER = 'https://tedkelly-assistant.REPLACE.workers.dev/chat';

const mock = await startMockAnthropic({ delayMs: 25 });
const worker = await startWorker({ port: 8798, anthropicPort: mock.port });

let endpoint = `${worker.base}/chat`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };
const site = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(siteRoot, p);
  if (!file.startsWith(siteRoot)) { res.writeHead(403); return res.end(); }
  try {
    let data = await readFile(file);
    const ext = path.extname(file);
    if (ext === '.html' && endpoint !== PLACEHOLDER) data = Buffer.from(data.toString().replaceAll(PLACEHOLDER, endpoint));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;
if (SHOTS) await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
async function newPage(viewport, { allowNetErrors = false } = {}) {
  const ctx = await browser.newContext({ viewport });
  // Google Fonts may be unreachable from the test box; that's not the widget's problem.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/fonts\.g/.test(t) || (m.location().url || '').includes('fonts.g')) return;
    if (/Failed to load resource/.test(t) && /ERR_FAILED|ERR_BLOCKED/.test(t)) return; // aborted font requests
    if (allowNetErrors && /Failed to load resource|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return { page, errors, close: () => ctx.close() };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(350); // let the open animation finish
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const lastBot = (page) => page.locator('.tka-msg.tka-bot').last();
const decodeMailto = (href) => {
  const u = new URL(href);
  return { to: u.pathname, subject: u.searchParams.get('subject'), body: u.searchParams.get('body') };
};

try {
  // ---------- desktop happy path ----------
  await test('desktop: launcher, open, greeting, chips, streamed reply, links', async () => {
    const { page, errors, close } = await newPage({ width: 1280, height: 800 });
    await page.goto(`${SITE}/`);
    const launch = page.locator('.tka-launch');
    await launch.waitFor({ state: 'visible' });
    assert.equal(await launch.textContent(), "Ask Ted's assistant");
    await shot(page, '01-desktop-closed');
    await launch.click();
    const panel = page.locator('.tka-panel');
    await panel.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tka-input');
    assert.match(await page.locator('.tka-msg.tka-bot').first().textContent(), /Hi, I'm Ted's assistant \(AI\)\. Ask me how automation could work in your shop\./);
    assert.equal(await page.locator('.tka-chip').count(), 3);
    assert.match(await page.locator('.tka-small').textContent(), /Nothing you type is stored/);
    await shot(page, '02-desktop-open');

    await page.locator('.tka-chip').first().click();
    await page.locator('.tka-typing').waitFor({ state: 'attached', timeout: 5000 });
    await page.waitForFunction(() => /shadow mode/.test(document.querySelectorAll('.tka-msg.tka-bot')[1]?.textContent || ''), null, { timeout: 15000 });
    await shot(page, '03-desktop-streaming');
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15000 });
    assert.equal(await page.locator('.tka-chip').count(), 0, 'chips go away after the first question');
    const link = lastBot(page).locator('a[href="https://tedkelly.dev/projects/work-order-intake/"]');
    assert.equal(await link.count(), 1, 'demo URL becomes a link');
    await page.waitForFunction(() => /shadow mode/.test(document.querySelector('.tka-sr[aria-live]').textContent), null, { timeout: 2000 }); // reply announced via aria-live

    // Ask by typing + Enter
    await page.locator('#tka-input').fill('Do I have to switch software?');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.tka-msg.tka-bot').length === 3 && !document.querySelector('[aria-busy="true"]'), null, { timeout: 15000 });
    assert.match(await lastBot(page).textContent(), /work-with-me/);
    // the Worker got the full history
    const sent = mock.requests.at(-1).body.messages;
    assert.equal(sent.length, 3);
    assert.equal(sent[0].content, 'What would you build first for a 10-tech HVAC shop?');
    assert.equal(sent[2].content, 'Do I have to switch software?');
    await shot(page, '04-desktop-conversation');

    // mailto summary
    const href = await page.locator('.tka-book').getAttribute('href');
    const m = decodeMailto(href);
    assert.equal(m.to, 'ted@tedkelly.dev');
    assert.equal(m.subject, 'Free 20-minute call');
    assert.match(m.body, /- What would you build first for a 10-tech HVAC shop\?/);
    assert.match(m.body, /- Do I have to switch software\?/);
    assert.ok(!/shadow mode/.test(m.body), 'replies are not in the email');
    assert.ok(href.length <= 1800);
    assert.ok(href.includes('%0D%0A'), 'CRLF line breaks');
    assert.deepEqual(errors, []);
    await close();
  });

  await test('keyboard: focus trap, Esc closes and returns focus', async () => {
    const { page, errors, close } = await newPage({ width: 1280, height: 800 });
    await page.goto(`${SITE}/safety/`);
    await page.locator('.tka-launch').waitFor();
    await page.locator('.tka-launch').focus();
    await page.keyboard.press('Enter');
    await page.locator('.tka-panel').waitFor({ state: 'visible' });
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.querySelector('.tka-panel').contains(document.activeElement)), `Tab ${i + 1} left the panel`);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      assert.ok(await page.evaluate(() => document.querySelector('.tka-panel').contains(document.activeElement)), `Shift+Tab ${i + 1} left the panel`);
    }
    // chips are reachable and work with the keyboard
    await page.locator('.tka-chip').nth(1).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.tka-msg.tka-user').length === 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tka-input', 'focus moves to the input after a chip');
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15000 });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.tka-panel').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.className), 'tka-launch');
    assert.equal(await page.locator('.tka-launch').getAttribute('aria-expanded'), 'false');
    // conversation survives a page change (sessionStorage, this tab only)
    await page.goto(`${SITE}/work-with-me/`);
    await page.locator('.tka-launch').click();
    assert.equal(await page.locator('.tka-msg.tka-user').count(), 1);
    assert.deepEqual(errors, []);
    await close();
  });

  // ---------- phone ----------
  await test('390px: full-screen panel, no horizontal scroll', async () => {
    const { page, errors, close } = await newPage({ width: 390, height: 844 });
    await page.goto(`${SITE}/case-study/`);
    await page.locator('.tka-launch').waitFor();
    const lb = await page.locator('.tka-launch').boundingBox();
    assert.ok(lb.x + lb.width <= 390 && lb.x >= 0);
    await shot(page, '05-mobile-closed');
    await page.locator('.tka-launch').click();
    const box = await page.locator('.tka-panel').boundingBox();
    assert.equal(Math.round(box.width), 390);
    assert.equal(Math.round(box.height), 844);
    await shot(page, '06-mobile-open');
    await page.locator('.tka-chip').nth(2).click();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && document.querySelectorAll('.tka-msg.tka-bot').length === 2, null, { timeout: 15000 });
    await page.locator('#tka-input').fill('x'.repeat(950));
    assert.match(await page.locator('.tka-count').textContent(), /950 \/ 1000/);
    await shot(page, '07-mobile-reply');
    const sw = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    assert.ok(sw <= 390, `horizontal overflow: ${sw}`);
    const bookBox = await page.locator('.tka-book').boundingBox();
    assert.ok(bookBox.y + bookBox.height <= 844, 'book button visible');
    assert.deepEqual(errors, []);
    await close();
  });

  // ---------- long conversation: mailto trimming and turn limit ----------
  await test('mailto stays under 1,800 chars; 12-question limit disables input', async () => {
    const { page, errors, close } = await newPage({ width: 1280, height: 800 });
    await page.goto(`${SITE}/`);
    await page.evaluate(() => {
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: 'user', content: `Question ${i + 1}: ` + 'we run a busy appliance repair shop & need help '.repeat(20) });
        messages.push({ role: 'assistant', content: 'Answer' });
      }
      sessionStorage.setItem('tka-chat-v1', JSON.stringify({ messages }));
    });
    await page.reload();
    await page.locator('.tka-launch').click();
    const href = await page.locator('.tka-book').getAttribute('href');
    assert.ok(href.length <= 1800, `mailto is ${href.length} chars`);
    const body = decodeMailto(href).body;
    assert.match(body, /Question 12/, 'keeps the latest questions');
    assert.match(body, /earlier question/);
    assert.equal(await page.locator('#tka-input').isDisabled(), true);
    assert.match(await lastBot(page).textContent(), /limit for this chat/);
    await shot(page, '08-turn-limit');
    assert.deepEqual(errors, []);
    await close();
  });

  // ---------- unreachable endpoint ----------
  await test('unreachable endpoint shows the friendly fallback', async () => {
    endpoint = 'http://127.0.0.1:9/chat';
    const { page, errors, close } = await newPage({ width: 1280, height: 800 }, { allowNetErrors: true });
    await page.goto(`${SITE}/`);
    await page.locator('.tka-launch').click();
    await page.locator('.tka-chip').first().click();
    await page.locator('.tka-msg.tka-error').waitFor({ timeout: 15000 });
    assert.match(await lastBot(page).textContent(), /can't reach the assistant right now.*ted@tedkelly\.dev/);
    assert.equal(await lastBot(page).locator('a[href^="mailto:ted@tedkelly.dev"]').count(), 1);
    assert.equal(await page.locator('.tka-book').isVisible(), true);
    assert.equal(await page.locator('#tka-input').isDisabled(), false, 'can still type');
    const m = decodeMailto(await page.locator('.tka-book').getAttribute('href'));
    assert.match(m.body, /What would you build first/, 'unanswered question still goes in the email');
    await shot(page, '09-fallback');
    assert.deepEqual(errors, []);
    await close();
  });

  await test('placeholder endpoint (not yet configured) shows the fallback without a request', async () => {
    endpoint = PLACEHOLDER;
    const { page, errors, close } = await newPage({ width: 390, height: 844 });
    const reqs = [];
    page.on('request', (r) => { if (r.url().includes('workers.dev')) reqs.push(r.url()); });
    await page.goto(`${SITE}/work-with-me/`);
    await page.locator('.tka-launch').click();
    await page.locator('#tka-input').fill('hello');
    await page.locator('.tka-send').click();
    await page.locator('.tka-msg.tka-error').waitFor({ timeout: 5000 });
    assert.equal(reqs.length, 0);
    await shot(page, '10-mobile-fallback');
    assert.deepEqual(errors, []);
    await close();
  });

  await test('Worker refusing the origin also falls back cleanly', async () => {
    // Serve the page from "localhost" but tell the widget to call a Worker that
    // will see a foreign origin: simulate by pointing at the mock's 404 path.
    endpoint = `http://127.0.0.1:${mock.port}/not-the-api`;
    const { page, errors, close } = await newPage({ width: 1280, height: 800 }, { allowNetErrors: true });
    await page.goto(`${SITE}/`);
    await page.locator('.tka-launch').click();
    await page.locator('#tka-input').fill('hi');
    await page.keyboard.press('Enter');
    await page.locator('.tka-msg.tka-error').waitFor({ timeout: 10000 });
    assert.deepEqual(errors.filter((e) => !/CORS|Access-Control/.test(e)), []);
    await close();
  });

  await test('demo pages do not load the widget', async () => {
    for (const p of ['/projects/', '/projects/work-order-intake/', '/projects/quote-builder/']) {
      const html = await (await fetch(SITE + p)).text();
      assert.ok(!html.includes('assistant.js'), p);
    }
  });
} finally {
  await browser.close();
  site.close();
  worker.stop();
  await mock.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
