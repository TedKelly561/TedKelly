// A tiny stand-in for the Anthropic Messages API (streaming only), for local tests.
// It records each request body and streams a canned reply in the real SSE format.
import http from 'node:http';

export function startMockAnthropic({ port = 0, reply = defaultReply, delayMs = 15 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'nope' } }));
      }
      const parsed = JSON.parse(body);
      requests.push({ headers: req.headers, body: parsed });
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user');
      const { text, stop_reason = 'end_turn', status } = reply(String(lastUser?.content ?? ''), parsed);
      if (status) {
        res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_mock' });
        return res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message: 'mock failure' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const usage = { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 11000 };
      send('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      const words = text.match(/\S+\s*/g) || [];
      for (const w of words) {
        send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: w } });
        await new Promise((r) => setTimeout(r, delayMs));
      }
      send('content_block_stop', { type: 'content_block_stop', index: 1 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: words.length } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) })),
  );
}

function defaultReply(q) {
  if (/refuse/i.test(q)) return { text: 'I', stop_reason: 'refusal' };
  if (/fail500/i.test(q)) return { status: 500 };
  if (/HVAC/i.test(q)) {
    return {
      text:
        "For a 10-tech HVAC shop, Ted would usually start with the piece that hurts most, often email intake (M1) or the morning digest (M2). It runs in shadow mode first, on the tools you already use. Try the intake demo: https://tedkelly.dev/projects/work-order-intake/ . Next step: book the free 20-minute call so Ted can say which module fits.",
    };
  }
  return { text: 'Ted builds automations for field-service shops. See https://tedkelly.dev/work-with-me/ for how it works.' };
}
