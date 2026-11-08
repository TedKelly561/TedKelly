// Request handling for the "Ask Ted's assistant" Worker (entry point: index.ts).
//
//   POST /chat    { messages: [{ role: "user" | "assistant", content: string }] }
//                 -> text/event-stream of  data: {"type":"text","text":"..."}
//                                          data: {"type":"done","stop_reason":"..."}
//                                          data: {"type":"error","message":"..."}
//                 (validation / origin / rate-limit failures are JSON with a 4xx status)
//   GET  /health  -> {"ok":true,...}
//
// Nothing a visitor sends is stored: no KV, no D1, no logging of message text.

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, KNOWLEDGE_VERSION } from "./knowledge";

export const MODEL = "claude-haiku-5-5";

export const LIMITS = {
  maxUserTurns: 12, // user messages per conversation
  maxUserChars: 1000, // per user message
  maxAssistantChars: 4000, // per assistant message the client echoes back (~800 tokens of reply)
  maxTotalChars: 20000, // whole conversation, all roles
  maxBodyBytes: 64 * 1024, // raw request body
  maxTokens: 800, // per reply (includes any thinking at low effort)
  // Fallback limiter only (the RATE_LIMITER binding is configured in wrangler.toml)
  fallbackPerMinute: 10,
} as const;

const STATIC_ORIGINS = new Set(["https://tedkelly.dev", "https://www.tedkelly.dev"]);

export interface Env {
  ANTHROPIC_API_KEY?: string;
  /** Workers Rate Limiting binding; see wrangler.toml. */
  RATE_LIMITER?: RateLimit;
  /** Local testing only: point the SDK at a mock API. Ignored unless it is a localhost URL. */
  ANTHROPIC_BASE_URL?: string;
}

/** The part of the SDK client this Worker uses, so tests can pass a fake. */
export type ChatClient = Pick<Anthropic, "messages">;

export interface Deps {
  makeClient?: (env: Env) => ChatClient;
  now?: () => number;
}

// ---------- origin / CORS ----------

export function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  if (STATIC_ORIGINS.has(origin)) return true;
  // Local testing: http://localhost:<any port> and http://127.0.0.1:<any port>
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: "Origin" };
  if (isAllowedOrigin(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

// ---------- rate limiting ----------

// Fallback when the RATE_LIMITER binding is missing (older wrangler, or the
// binding removed): a fixed one-minute window per IP, in this isolate's memory.
// It is per-isolate and resets when the isolate is recycled, so it is a speed
// bump, not a guarantee. The binding is the real limiter.
const fallbackWindows = new Map<string, { start: number; count: number }>();

export function _resetFallbackLimiter(): void {
  fallbackWindows.clear();
}

async function allowRequest(env: Env, ip: string, now: number): Promise<boolean> {
  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      return success;
    } catch {
      // fall through to the in-memory limiter
    }
  }
  const w = fallbackWindows.get(ip);
  if (!w || now - w.start >= 60_000) {
    if (fallbackWindows.size > 5000) fallbackWindows.clear();
    fallbackWindows.set(ip, { start: now, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= LIMITS.fallbackPerMinute;
}

// ---------- input validation ----------

export type Validated = { ok: true; messages: Anthropic.MessageParam[] } | { ok: false; status: number; error: string; message: string };

const fail = (status: number, error: string, message: string): Validated => ({ ok: false, status, error, message });

export function validateMessages(body: unknown): Validated {
  if (!body || typeof body !== "object" || !Array.isArray((body as { messages?: unknown }).messages)) {
    return fail(400, "bad_request", "Expected { messages: [...] }.");
  }
  const raw = (body as { messages: unknown[] }).messages;
  if (raw.length > LIMITS.maxUserTurns * 2 + 4) return fail(400, "too_many_messages", "This conversation is too long.");

  const out: Anthropic.MessageParam[] = [];
  let total = 0;
  let userTurns = 0;
  for (const m of raw) {
    if (!m || typeof m !== "object") return fail(400, "bad_message", "Each message must be an object.");
    const { role, content } = m as { role?: unknown; content?: unknown };
    // A client never gets to set the system prompt: system (and developer) roles are dropped.
    if (role === "system" || role === "developer") continue;
    if (role !== "user" && role !== "assistant") return fail(400, "bad_role", "Messages must have role user or assistant.");
    // Text only: no image / document / tool blocks, no arrays of blocks.
    if (typeof content !== "string") return fail(400, "text_only", "Only plain text messages are supported.");
    const text = content.replace(/\u0000/g, "").trim();
    if (!text) return fail(400, "empty_message", "Messages can't be empty.");
    if (role === "user") {
      userTurns += 1;
      if (text.length > LIMITS.maxUserChars) {
        return fail(413, "message_too_long", `Please keep each message under ${LIMITS.maxUserChars} characters.`);
      }
    } else if (text.length > LIMITS.maxAssistantChars) {
      return fail(413, "message_too_long", "A previous reply is too long.");
    }
    total += text.length;
    // Merge consecutive same-role messages so the history always alternates.
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content = `${prev.content as string}\n\n${text}`;
    else out.push({ role, content: text });
  }
  if (out.length === 0) return fail(400, "bad_request", "No messages.");
  if (out[0].role !== "user") return fail(400, "bad_order", "The conversation must start with a user message.");
  if (out[out.length - 1].role !== "user") return fail(400, "bad_order", "The last message must be from the user.");
  if (userTurns > LIMITS.maxUserTurns) {
    return fail(429, "turn_limit", `This chat has reached its ${LIMITS.maxUserTurns}-question limit. Book a free 20-minute call to keep talking with Ted.`);
  }
  if (total > LIMITS.maxTotalChars) return fail(413, "conversation_too_long", "This conversation is too long. Book a free 20-minute call to keep talking with Ted.");
  return { ok: true, messages: out };
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const type = request.headers.get("Content-Type") || "";
  if (!/^application\/json\b/i.test(type) && !/^text\/plain\b/i.test(type)) {
    return { ok: false, status: 415, error: "unsupported_media_type" };
  }
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (declared > LIMITS.maxBodyBytes) return { ok: false, status: 413, error: "body_too_large" };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > LIMITS.maxBodyBytes) return { ok: false, status: 413, error: "body_too_large" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { ok: false, status: 400, error: "bad_json" };
  }
}

// ---------- the model call ----------

export function defaultClient(env: Env): ChatClient {
  const base = env.ANTHROPIC_BASE_URL;
  const local = base && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(base);
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(local ? { baseURL: base } : {}),
    maxRetries: 1,
    timeout: 30_000,
  });
}

const REFUSAL_TEXT =
  "Sorry, I can't help with that one. I can answer questions about Ted's automation work for field-service, repair and warranty businesses, or you can email Ted at ted@tedkelly.dev.";
const MAX_TOKENS_NOTE = " … (That's as much as I can fit in one answer. Ask me to go on, or book a free 20-minute call with Ted.)";
const ERROR_TEXT = "Sorry, the assistant isn't available right now. You can email Ted directly at ted@tedkelly.dev.";

function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function streamReply(client: ChatClient, messages: Anthropic.MessageParam[], origin: string, ctx?: ExecutionContext): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const run = async () => {
    let sentText = false;
    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: LIMITS.maxTokens,
        // Claude Haiku 5.5 runs adaptive thinking by default; low effort keeps a chat
        // reply quick and cheap. No temperature / top_p (non-default values 400 on this model).
        output_config: { effort: "low" },
        // The system prompt is frozen per deploy, so it's the cache breakpoint.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages,
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
          sentText = true;
          await writer.write(sse({ type: "text", text: event.delta.text }));
        }
      }
      const final = await stream.finalMessage();
      // Always check stop_reason before trusting the content.
      switch (final.stop_reason) {
        case "refusal":
          // A refusal can arrive mid-reply; tell the widget to replace what it showed.
          await writer.write(sse({ type: "replace", text: REFUSAL_TEXT }));
          break;
        case "max_tokens":
          await writer.write(sse({ type: "text", text: sentText ? MAX_TOKENS_NOTE : MAX_TOKENS_NOTE.replace(/^ … /, "") }));
          break;
        default:
          if (!sentText) await writer.write(sse({ type: "text", text: "Sorry, I didn't catch that. Could you ask it another way?" }));
      }
      await writer.write(sse({ type: "done", stop_reason: final.stop_reason }));
    } catch (err) {
      // Log the class and status only, never message content.
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const kind =
        err instanceof Anthropic.AuthenticationError ? "auth" :
        err instanceof Anthropic.RateLimitError ? "rate_limited" :
        err instanceof Anthropic.BadRequestError ? "bad_request" :
        err instanceof Anthropic.APIConnectionError ? "connection" :
        err instanceof Anthropic.APIError ? "api" : "internal";
      console.error(`chat upstream error: ${kind}${status ? ` ${status}` : ""}`);
      try {
        await writer.write(sse({ type: "error", error: kind, message: ERROR_TEXT }));
      } catch {
        /* client went away */
      }
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  };
  const p = run();
  ctx?.waitUntil(p);

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
    },
  });
}

// ---------- router ----------

export async function handleRequest(request: Request, env: Env, ctx?: ExecutionContext, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");

  if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    return json({ ok: true, model: MODEL, knowledge: KNOWLEDGE_VERSION, configured: Boolean(env.ANTHROPIC_API_KEY) }, 200, origin);
  }

  if (url.pathname !== "/chat") return json({ error: "not_found" }, 404, origin);

  if (request.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin, { Allow: "POST, OPTIONS" });

  // Browsers always send Origin on a cross-site POST. A missing or foreign Origin is refused.
  if (!isAllowedOrigin(origin)) return json({ error: "forbidden_origin" }, 403, null);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = (deps.now ?? Date.now)();
  if (!(await allowRequest(env, ip, now))) {
    return json({ error: "rate_limited", message: "You're sending messages quickly. Please wait a minute and try again." }, 429, origin, { "Retry-After": "60" });
  }

  const body = await readBody(request);
  if (!body.ok) return json({ error: body.error }, body.status, origin);

  const v = validateMessages(body.value);
  if (!v.ok) return json({ error: v.error, message: v.message }, v.status, origin);

  if (!env.ANTHROPIC_API_KEY) {
    console.error("chat: ANTHROPIC_API_KEY secret is not set");
    return json({ error: "not_configured", message: ERROR_TEXT }, 503, origin);
  }

  const client = (deps.makeClient ?? defaultClient)(env);
  return streamReply(client, v.messages, origin, ctx);
}

