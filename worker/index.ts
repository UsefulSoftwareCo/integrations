import { apiHandler } from "./api.ts";

export { McpDurableObject } from "./mcp-do.ts";

interface DurableObjectStub {
  fetch: (request: Request) => Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => DurableObjectStub;
}

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  POSTHOG_KEY: string;
  MCP: DurableObjectNamespace;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers },
  });

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // MCP server — point Claude/Cursor at /mcp. Routed through a single Durable
    // Object so the session map persists across stateless Worker requests.
    if (url.pathname === "/mcp") {
      return env.MCP.get(env.MCP.idFromName("mcp")).fetch(request);
    }

    // Self-describe via the same discovery format the catalog indexes: point at
    // our own OpenAPI + MCP endpoint.
    if (url.pathname === "/.well-known/api-catalog") {
      return json(
        {
          linkset: [{
            anchor: "https://integrations.sh",
            "service-desc": [{ href: "https://integrations.sh/openapi.json", type: "application/openapi+json" }],
            "service-doc": [{ href: "https://integrations.sh" }],
            item: [{ href: "https://integrations.sh/mcp", type: "application/json" }],
          }],
        },
        200,
        { "cache-control": "public, max-age=86400" },
      );
    }

    // The API + its OpenAPI doc — single source of truth (worker/api.ts).
    if (url.pathname === "/openapi.json" || url.pathname.startsWith("/api/")) {
      const cache = (caches as unknown as { default: Cache }).default;
      const cached = await cache.match(request);
      if (cached) return cached;
      const res = await apiHandler(request);
      if (request.method === "GET" && res.status === 200) {
        const out = new Response(res.clone().body, res);
        out.headers.set("cache-control", "public, max-age=3600");
        ctx.waitUntil(cache.put(request, out.clone()));
        return out;
      }
      return res;
    }

    // Analytics: count executor-agent hits.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const country = request.headers.get("cf-ipcountry") || "unknown";
    const agent = request.headers.get("user-agent") || "unknown";
    if (agent.includes("executor")) {
      ctx.waitUntil(
        fetch("https://us.i.posthog.com/i/v0/e/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: env.POSTHOG_KEY,
            event: "hit",
            distinct_id: ip,
            properties: { $process_person_profile: false, user_agent: agent, country, path: url.pathname },
          }),
        }),
      );
    }

    return await env.ASSETS.fetch(request);
  },
};
