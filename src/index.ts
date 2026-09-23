import { api } from "./api";
import { getClawpostApiKey } from "./config";
import { handleInboundEmail } from "./email";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { EmailMCP };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Route /mcp to McpAgent Durable Object
    if (url.pathname.startsWith("/mcp")) {
      // Auth check
      const auth = request.headers.get("Authorization");
      const expected = `Bearer ${getClawpostApiKey(env)}`;

      if (!auth) {
        return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const expectedBytes = new TextEncoder().encode(expected);
      const providedBytes = new TextEncoder().encode(auth);

      if (
        expectedBytes.byteLength !== providedBytes.byteLength ||
        !crypto.subtle.timingSafeEqual(expectedBytes, providedBytes)
      ) {
        return new Response(JSON.stringify({ error: "Invalid API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      return EmailMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(
        request,
        env,
        ctx
      );
    }

    // Everything else → Hono API
    return api.fetch(request, env, ctx);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    await handleInboundEmail(message, env, ctx);
  },
};
