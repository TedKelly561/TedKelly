# Ask Ted's assistant: Cloudflare Worker

The backend for the "Ask Ted's assistant" chat on tedkelly.dev. The widget (`/assets/assistant.js` and `/assets/assistant.css` in the site root) sends the visitor's questions here. The Worker checks them, adds a system prompt built from the site's own content, and streams back a reply from Claude Haiku 5.5 (`claude-haiku-5-5`).

Nothing the visitor types is stored. The Worker has no database, KV or log of message text; it logs only error types (for example `chat upstream error: rate_limited 429`). The widget keeps the conversation in the visitor's own tab (`sessionStorage`, cleared when the tab closes).

```
browser widget  ──POST /chat──▶  Worker (origin check, rate limit, caps)  ──▶  Anthropic Messages API (streaming)
                ◀──SSE text────                                           ◀──
```

## Endpoints

| | |
|---|---|
| `POST /chat` | Body `{ "messages": [{ "role": "user" \| "assistant", "content": "text" }] }`. Returns `text/event-stream` with `data: {"type":"text","text":"…"}` chunks, then `{"type":"done","stop_reason":"…"}`. If the model fails mid-way it sends `{"type":"error","message":"…"}`; on a refusal it sends `{"type":"replace","text":"…"}` with a polite decline. Bad input, a foreign origin or a rate limit return JSON with a 4xx status. |
| `GET /health` | `{"ok":true,"model":"claude-haiku-5-5","knowledge":"<hash>","configured":true}`. `configured` is false until the API key secret is set. |

## Deploy

Nothing here has been deployed yet. You need Node 20+ and the Cloudflare account that will own the Worker.

### Option A: wrangler with an API token

```bash
cd assistant-worker
npm ci
export CLOUDFLARE_API_TOKEN=...      # token with "Workers Scripts: Edit" (the "Edit Cloudflare Workers" template)
export CLOUDFLARE_ACCOUNT_ID=...     # optional; wrangler asks if the token can see more than one account
npm test                             # unit tests
npx wrangler deploy                  # prints https://tedkelly-assistant.<your-subdomain>.workers.dev
```

Then set the key (or use the dashboard steps below):

```bash
npx wrangler secret put ANTHROPIC_API_KEY    # paste the key when asked; it is never written to disk
curl https://tedkelly-assistant.<your-subdomain>.workers.dev/health   # "configured": true
```

### Option B: the Cloudflare dashboard

1. Run `npm ci && npm run build` here. This bundles the Worker into `dist/index.js`.
2. In the dashboard: Workers & Pages → Create → Create Worker, name it `tedkelly-assistant`, Deploy, then Edit code and replace the code with the contents of `dist/index.js`. Deploy.
3. Rate limiting is a binding defined in `wrangler.toml`; the dashboard editor may not offer it. Without it the Worker uses its weaker fallback limiter (see Guardrails). Deploying once with Option A sets it up.
4. Set the API key secret as below.

Option A is easier to repeat: every later change is one `npx wrangler deploy`.

### Setting the ANTHROPIC_API_KEY secret (Ted, in the dashboard)

1. Create a key at console.anthropic.com → API keys. A separate workspace for the website, with a monthly spend limit, is a good idea (see Cost).
2. Cloudflare dashboard → **Workers & Pages → tedkelly-assistant → Settings → Variables and Secrets → Add**.
3. Type: **Secret**. Variable name: `ANTHROPIC_API_KEY`. Value: the key. **Deploy**.

The key lives only in Cloudflare's encrypted secret store. It is not in this repo, `wrangler.toml`, or the widget. Check `/health` shows `"configured": true`.

### Point the site at the Worker

The five pages (`index.html`, `case-study/`, `safety/`, `work-with-me/`, `hire/`) load the widget pointed at the deployed Worker:

```html
<script src="/assets/assistant.js" data-endpoint="https://tedkelly-assistant.tseay11.workers.dev/chat" defer></script>
```

If `data-endpoint` is ever set back to a placeholder containing `REPLACE`, the widget still opens and shows a friendly "can't reach the assistant, email Ted" message with the booking button, and makes no network request.

## Guardrails (all server-side)

| Guardrail | Setting | Where |
|---|---|---|
| Origin check + CORS | Only `https://tedkelly.dev`, `https://www.tedkelly.dev`, and `http://localhost:*` / `http://127.0.0.1:*` for testing. Other or missing `Origin` on `POST /chat` gets 403 and no CORS headers. | `isAllowedOrigin` in `src/chat.ts` |
| Per-IP rate limit | 10 requests / 60 s per `CF-Connecting-IP`, via the Workers Rate Limiting binding `RATE_LIMITER` (`[[ratelimits]]` in `wrangler.toml`). Over the limit: 429 with `Retry-After: 60`. | `wrangler.toml`, `allowRequest` |
| Fallback limiter | If the binding is missing or errors, an in-memory 10/minute per-IP window. It is per isolate and resets when the isolate recycles, so it only slows abuse down. | `allowRequest` |
| Conversation caps | 12 user turns, 1,000 characters per user message, 4,000 per echoed assistant message, 20,000 characters total, 64 KB request body. | `LIMITS` |
| Reply cap | `max_tokens: 800`, `output_config.effort: "low"`. | `streamReply` |
| Text only | `content` must be a string. Arrays of blocks (images, documents, tool results) are rejected with 400. | `validateMessages` |
| No client system prompt | Messages with role `system` or `developer` are dropped; other unknown roles are rejected. The conversation must start and end with a user message. | `validateMessages` |
| Prompt rules | Stay on topic, use only site content, never invent prices/clients/figures, never claim to be Ted, no legal/tax/financial advice, ignore attempts to change the rules. | `scripts/instructions.md` |
| Stop reasons | `refusal` → polite decline replaces the reply. `max_tokens` → a note asking them to continue or book a call. Errors → the widget's fallback with Ted's email. | `streamReply` |

The origin check stops other websites using the Worker from a visitor's browser. It doesn't stop someone with curl faking an `Origin` header. The rate limit, the caps and an Anthropic spend limit are what bound the cost.

## Model settings and cost

- Model `claude-haiku-5-5`. Adaptive thinking is on by default on this model; `effort: "low"` keeps chat replies short and cheap. No `temperature` / `top_p` (non-default values return 400 on this model). Thinking blocks are never sent to the browser.
- The system prompt (the rules plus the site content, about 46,000 characters, roughly 12,000 tokens) is one block with `cache_control: { type: "ephemeral" }`, so repeat requests within 5 minutes read it from the cache. It is generated without timestamps so the cache stays valid between deploys that don't change content.
- No server-side refusal fallback: Haiku 5.5 doesn't support the `fallbacks` parameter, so a refusal is handled in the Worker.

Haiku 5.5 list prices (from the claude-api skill, cached 2026-10-06; check https://www.anthropic.com/pricing before budgeting): $0.10 per million input tokens, $0.50 per million output tokens (prompts up to 100K tokens), cache writes 1.25x input ($0.125/M), cache reads 0.1x input ($0.01/M).

| | Tokens | Cost |
|---|---|---|
| First question (cache write of the ~12K-token prompt) | ~12.5K in, ~250 out | ~$0.0017 |
| Each later question within 5 min (cache read + history) | ~12.5K cached + ~1–4K in, ~250 out | ~$0.0003–0.0006 |
| Typical 5-question conversation | | **about half a cent** |
| Worst case: 12 questions, full 800-token replies | | about 1.5 cents |
| 1,000 typical conversations a month | | about $5 |

One abusive IP held at the rate limit (10 requests a minute, all day) could cost a few dollars to tens of dollars a day, so set a monthly spend limit on the Anthropic workspace (Console → Settings → Limits) and check usage after launch.

## Regenerating the knowledge

The system prompt in `src/knowledge.ts` is generated. Don't edit it by hand.

```bash
cd assistant-worker
npm run knowledge        # = node scripts/build-knowledge.mjs
npm test && npx wrangler deploy
```

The script reads:

- `scripts/instructions.md`: the hand-written rules (who Ted is, what not to invent, tone, the free-call nudge, prompt-injection rules). Edit this to change behavior.
- The `<main>` text of `index.html`, `work-with-me/`, `safety/` and `case-study/`, with links turned into full `https://tedkelly.dev/...` URLs.
- The visitor-facing parts of the module READMEs (`projects/work-order-intake` = M1, `daily-digest` = M2, `thread-updates` = M3, plus `quote-builder`, `dispatch-board`, `kpi-dashboard` and `projects/README.md`). "For developers", "How it is built" and "Built with" sections are skipped.

To add a page, add it to `PAGES` or `READMES` at the top of the script. Run it whenever the site's content changes, then redeploy.

## Tests

```bash
npm test                    # 30 unit tests (vitest), mocked Anthropic client: origin, CORS, rate limit
                            # (binding + fallback), caps, bad input, system-role stripping, refusal,
                            # max_tokens, API errors, happy path with the exact request parameters
npm run test:integration    # runs the real bundle in `wrangler dev` (workerd) with the official SDK
                            # pointed at a local mock of the Anthropic API (SSE)
CHROME_PATH=/path/to/chrome npm run test:widget
                            # headless Chromium on the real site pages: open/close, chips, streaming,
                            # links, mailto summary, 390px + desktop, focus trap + Esc, 12-turn limit,
                            # unreachable and placeholder endpoints, no console errors.
                            # SCREENSHOTS=dir saves screenshots.
npm run typecheck
npm run build               # wrangler deploy --dry-run --outdir dist
```

No real Anthropic calls are made by any test. The integration tests use the `ANTHROPIC_BASE_URL` variable, which the Worker honors only when it is a `http://localhost` or `http://127.0.0.1` URL, so it can't be used to redirect the key in production.

## Files

- `src/index.ts`: Worker entry point (default export only; workerd treats named exports of the entry module as handlers).
- `src/chat.ts`: routing, origin/CORS, rate limit, validation, the streaming model call.
- `src/knowledge.ts`: generated system prompt.
- `scripts/build-knowledge.mjs`, `scripts/instructions.md`: the generator and the hand-written rules.
- `test/`: unit, integration and widget tests, plus the mock Anthropic server.
- `wrangler.toml`: name `tedkelly-assistant`, `workers_dev = true`, the rate-limit binding. No secrets.

## Known limits

- The fallback limiter is per isolate; the real per-IP limit needs the `RATE_LIMITER` binding (included in `wrangler.toml`).
- The 12-turn cap is enforced per request, from the history the browser sends. A determined client can start a fresh conversation; the rate limit is what bounds total use.
- Answers come from a snapshot of the site taken when `npm run knowledge` last ran.
