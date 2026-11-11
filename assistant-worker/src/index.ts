// Cloudflare Worker entry point for the "Ask Ted's assistant" chat on tedkelly.dev.
// Only the default export lives here: workerd treats every named export of the
// entry module as a handler. The logic is in ./chat.ts.
import { handleRequest, type Env } from "./chat";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
