// End-to-end check of the real Worker bundle under `wrangler dev` (workerd),
// with the official SDK talking to a local mock of the Anthropic API.
//   npm run test:integration
import assert from 'node:assert/strict';
import { startMockAnthropic } from './mock-anthropic.mjs';
import { startWorker } from './dev-server.mjs';

const mock = await startMockAnthropic();
const worker = await startWorker({ anthropicPort: mock.port });
const ORIGIN = 'https://tedkelly.dev';
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const chat = (body, { origin = ORIGIN, ip = '192.0.2.1', type = 'text/plain;charset=UTF-8' } = {}) =>
  fetch(`${worker.base}/chat`, { method: 'POST', headers: { 'Content-Type': type, ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const sse = async (res) => (await res.text()).split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));

try {
  await test('GET /health', async () => {
    const r = await fetch(`${worker.base}/health`);
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.model, 'claude-haiku-5-5'); assert.equal(j.configured, true);
  });
  await test('happy path streams text through the real SDK', async () => {
    const r = await chat({ messages: [{ role: 'user', content: 'What would you build first for a 10-tech HVAC shop?' }] });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /event-stream/);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    const ev = await sse(r);
    const text = ev.filter((e) => e.type === 'text').map((e) => e.text).join('');
    assert.match(text, /shadow mode/);
    assert.deepEqual(ev.at(-1), { type: 'done', stop_reason: 'end_turn' });
    const req = mock.requests.at(-1);
    assert.equal(req.body.model, 'claude-haiku-5-5');
    assert.equal(req.body.max_tokens, 800);
    assert.equal(req.body.stream, true);
    assert.deepEqual(req.body.output_config, { effort: 'low' });
    assert.equal(req.body.system[0].cache_control.type, 'ephemeral');
    assert.ok(req.body.system[0].text.length > 20000);
    // SDK 1.x sends the API key as a bearer token.
    assert.equal(req.headers.authorization, 'Bearer sk-ant-test-not-real');
  });
  await test('refusal is replaced with a polite message', async () => {
    const ev = await sse(await chat({ messages: [{ role: 'user', content: 'please refuse' }] }, { ip: '192.0.2.2' }));
    assert.ok(ev.some((e) => e.type === 'replace'));
    assert.equal(ev.at(-1).stop_reason, 'refusal');
  });
  await test('upstream 500 becomes an error event', async () => {
    const ev = await sse(await chat({ messages: [{ role: 'user', content: 'fail500' }] }, { ip: '192.0.2.3' }));
    assert.equal(ev.at(-1).type, 'error');
  });
  await test('foreign origin is refused', async () => {
    const r = await chat({ messages: [{ role: 'user', content: 'hi' }] }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });
  await test('preflight from localhost', async () => {
    const r = await fetch(`${worker.base}/chat`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });
  await test('non-text content and long messages are rejected', async () => {
    assert.equal((await chat({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }] }, { ip: '192.0.2.4' })).status, 400);
    assert.equal((await chat({ messages: [{ role: 'user', content: 'x'.repeat(1001) }] }, { ip: '192.0.2.4' })).status, 413);
  });
  await test('rate limit binding kicks in (10 per minute per IP)', async () => {
    const statuses = [];
    for (let i = 0; i < 14; i++) {
      const r = await chat({ messages: [{ role: 'user', content: 'hi' }] }, { ip: '192.0.2.99' });
      statuses.push(r.status); await r.text();
    }
    // wrangler dev sets CF-Connecting-IP itself, so every request in this run
    // shares one key and the earlier tests already used part of the budget.
    assert.ok(statuses.includes(429), `no 429 in ${statuses.join(',')}`);
  });
} finally {
  worker.stop();
  await mock.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(worker.log().slice(-3000)); process.exit(1); }
process.exit(0);
