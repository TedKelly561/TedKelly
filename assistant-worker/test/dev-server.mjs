// Starts `wrangler dev` (local mode) pointed at a mock Anthropic API. Test helper.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startWorker({ port = 8799, anthropicPort, apiKey = 'sk-ant-test-not-real' } = {}) {
  const args = ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session=false', '--persist-to', mkdtempSync(path.join(os.tmpdir(), 'tka-state-')), '--var', `ANTHROPIC_BASE_URL:http://127.0.0.1:${anthropicPort}`];
  if (apiKey) args.push('--var', `ANTHROPIC_API_KEY:${apiKey}`);
  const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', WRANGLER_SEND_METRICS: 'false' };
  const child = spawn('npx', args, { cwd: workerDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (Date.now() >= deadline) throw new Error(`wrangler dev did not start:\n${log}`);
  return {
    base,
    log: () => log,
    stop: () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    },
  };
}
