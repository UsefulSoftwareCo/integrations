/**
 * Custom Worker entry. Owns the non-page transports — the MCP Durable Object
 * route, the first-party analytics proxy, the Effect HttpApi (detect/discover +
 * /openapi.json) with its edge cache, and the discovery SSE stream — then hands
 * everything else to Astro. Every HTML page, prerendered or on-demand, renders
 * through the Astro app (src/pages/*), so there is exactly one page pipeline.
 *
 * The Astro Cloudflare adapter calls `createExports(manifest)` and re-exports
 * what it returns — `default` (the fetch handler) plus the names listed in
 * astro.config.mjs `workerEntryPoint.namedExports` (the Durable Object class).
 */
import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";
import { apiHandler } from "./api.ts";
import { setChat, setWebBackend, discoverWithProgress } from "./operations.ts";
import { contextWeb, naiveWeb } from "../src/lib/contextdev.ts";
import type { EdgeCaches, Env, ExecutionContext } from "./env.ts";
import { McpDurableObject } from "./mcp-do.ts";

// Bump when detect/discover output shape or logic changes, so the edge Cache API
// (which survives deploys) stops serving results produced by the old code.
const CACHE_VERSION = "13";

// The discovery-loop model. gpt-5.4-mini drives the agentic tool-calling loop
// (search/sitemap/scrape/report) — ~1s per tool-decision turn on chat/completions.
// (Note: gpt-5.x rejects `reasoning_effort` alongside function tools here, so we
// don't set it.) gpt-4o-mini is a cheaper alternative.
const OPENAI_MODEL = "gpt-5.4-mini";

// Spend cap: OpenAI spend is bounded by the usage limit on the OpenAI project/key.
// To route through Cloudflare AI Gateway instead, point this at the gateway's
// OpenAI endpoint (needs "Authenticated Gateway" off, or a cf-aig-authorization token):
//   `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai/chat/completions`
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface ChatCompletion {
  choices?: Array<{ message?: { role: string; content?: string | null; tool_calls?: OpenAiToolCall[] } }>;
  error?: { message?: string };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Wire the discovery loop's chat model + web backend to env bindings. `env` is
 * stable per isolate, so setting these each request is idempotent. */
function wireAi(env: Env): void {
  setWebBackend(env.CONTEXT_DEV_API_KEY ? contextWeb(env.CONTEXT_DEV_API_KEY) : naiveWeb());
  if (!env.OPENAI_API_KEY) {
    setChat(null);
    return;
  }
  setChat(async (messages, tools) => {
    const body: Record<string, unknown> = { model: OPENAI_MODEL, messages, tools, tool_choice: "auto", parallel_tool_calls: true };
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await res.json()) as ChatCompletion;
    const message = d.choices?.[0]?.message ?? { role: "assistant", content: "" };
    const toolCalls = (message.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: parseArgs(tc.function.arguments) }));
    return { message, toolCalls };
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers },
  });

/** Fire-and-forget server-side PostHog capture. Browser pageviews come from
 * posthog-js (src/lib/analytics.ts); this covers the callers that never run
 * JS — agents fetching data files, MCP clients, and direct API users. */
function track(env: Env, ctx: ExecutionContext, request: Request, event: string, properties: Record<string, unknown> = {}): void {
  if (!env.POSTHOG_KEY) return;
  ctx.waitUntil(
    fetch("https://us.i.posthog.com/i/v0/e/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_KEY,
        event,
        distinct_id: request.headers.get("cf-connecting-ip") || "unknown",
        properties: {
          $process_person_profile: false,
          user_agent: request.headers.get("user-agent") || "unknown",
          country: request.headers.get("cf-ipcountry") || "unknown",
          path: new URL(request.url).pathname,
          ...properties,
        },
      }),
    }).catch(() => {}),
  );
}

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);

  const fetchHandler = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    wireAi(env);

    // First-party analytics proxy — posthog-js points api_host here (see
    // src/lib/analytics.ts), so ingestion is same-origin and survives tracker
    // blocklists. Static assets (array.js) come from the assets host;
    // everything else goes to ingestion. Pass the client IP through so PostHog
    // geolocates the visitor rather than the Cloudflare edge.
    if (url.pathname.startsWith("/_i/")) {
      const upstream = url.pathname.startsWith("/_i/static/")
        ? "https://us-assets.i.posthog.com"
        : "https://us.i.posthog.com";
      const target = new URL(url.pathname.slice(3) + url.search, upstream);
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      const ip = request.headers.get("cf-connecting-ip");
      if (ip) headers.set("x-forwarded-for", ip);
      return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "follow" }));
    }

    // MCP server — point Claude/Cursor at /mcp. Routed through a single Durable
    // Object so the session map persists across stateless Worker requests.
    if (url.pathname === "/mcp") {
      track(env, ctx, request, "mcp_request");
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

    // Stored discovery — the durable KV result for a domain, written on the
    // last completion. The domain page reads this at render/mount and merges it
    // with the static catalog. 404 when nothing has been discovered yet.
    const storedMatch = /^\/api\/([^/]+)\/discovery\/?$/.exec(url.pathname);
    if (storedMatch) {
      const domain = decodeURIComponent(storedMatch[1]).trim().toLowerCase();
      const raw = await env.DISCOVERY.get(domain);
      return new Response(raw ?? JSON.stringify({ stored: false }), {
        status: raw ? 200 : 404,
        headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=60" },
      });
    }

    // Discover with live progress — Server-Sent Events for the UI. Emits a
    // `progress` event per pipeline phase, then a `done` event with the full
    // result. Shares the discover edge cache: a warm result streams `done`
    // instantly; a cold run streams real progress and warms the cache.
    const streamMatch = /^\/api\/([^/]+)\/discover\/stream\/?$/.exec(url.pathname);
    if (streamMatch) {
      const domain = decodeURIComponent(streamMatch[1]);
      const cache = (caches as unknown as EdgeCaches).default;
      const keyUrl = new URL(url.origin + `/api/${encodeURIComponent(domain)}/discover`);
      keyUrl.searchParams.set("__cv", CACHE_VERSION);
      const cacheKey = new Request(keyUrl.toString(), { method: "GET" });

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      const producer = (async () => {
        try {
          const cached = await cache.match(cacheKey);
          track(env, ctx, request, "discovery_run", { domain, cached: !!cached });
          if (cached) {
            const result = (await cached.json()) as { domain?: string };
            await send("done", result);
            // Backfill KV so a cache-served result still lands in durable storage.
            if (result.domain) {
              ctx.waitUntil(env.DISCOVERY.put(result.domain, JSON.stringify({ result, discoveredAt: new Date().toISOString(), model: OPENAI_MODEL })));
            }
          } else {
            const result = await discoverWithProgress(domain, (ev) => {
              if (ev.kind === "progress") void send("progress", { message: ev.message });
              else if (ev.kind === "credential") void send("credential", { id: ev.id, credential: ev.credential });
              else if (ev.kind === "surface") void send("surface", ev.surface);
            });
            await send("done", result);
            const toCache = new Response(JSON.stringify(result), {
              headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=86400" },
            });
            ctx.waitUntil(cache.put(cacheKey, toCache));
            // Persist durably, keyed by the normalized domain, for render-time reads.
            if (result.domain) {
              ctx.waitUntil(env.DISCOVERY.put(result.domain, JSON.stringify({ result, discoveredAt: new Date().toISOString(), model: OPENAI_MODEL })));
            }
          }
        } catch {
          await send("error", { message: "Discovery failed." });
        } finally {
          await writer.close();
        }
      })();
      ctx.waitUntil(producer);

      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "access-control-allow-origin": "*",
          "x-accel-buffering": "no",
        },
      });
    }

    // Dynamic API (the Effect HttpApi) — detect, discover + the OpenAPI doc.
    // Other /api/* paths (e.g. the static /api/domains.json) fall through to Astro.
    if (url.pathname === "/openapi.json" || /^\/api\/[^/]+\/(?:detect|discover)\/?$/.test(url.pathname)) {
      track(env, ctx, request, "api_request");
      const cache = (caches as unknown as EdgeCaches).default;
      // Version the cache key so a deploy that bumps CACHE_VERSION orphans stale
      // entries (the Cache API otherwise survives deploys).
      const keyUrl = new URL(request.url);
      keyUrl.searchParams.set("__cv", CACHE_VERSION);
      const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      const res = await apiHandler(request);
      if (request.method === "GET" && res.status === 200) {
        const out = new Response(res.clone().body, res);
        // discover runs the LLM agent — cache a day; detect/openapi are cheap — an hour.
        out.headers.set("cache-control", url.pathname.includes("/discover") ? "public, max-age=86400" : "public, max-age=3600");
        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      }
      return res;
    }

    // Analytics on fallthrough: `hit` for executor agents (kept as-is —
    // pre-launch dashboards query it), `data_fetch` for any non-browser caller
    // pulling the machine-readable files. Browser pageviews are client-side.
    const agent = request.headers.get("user-agent") || "unknown";
    if (agent.includes("executor")) {
      track(env, ctx, request, "hit");
    } else if (!agent.includes("Mozilla") && (/\.json$/.test(url.pathname) || url.pathname.startsWith("/.well-known/"))) {
      // Browsers (the homepage fetches /api/domains.json) identify as Mozilla;
      // what's left is curl, scripts, and agents pulling the data files.
      track(env, ctx, request, "data_fetch");
    }

    // Domain page with a STORED discovery → SSR it with the map baked in
    // (src/pages/ssr/[domain].astro) instead of the prerendered asset, so
    // returning visitors don't get the idle-button flash while the island
    // fetches. One KV read per page view; a miss falls through to the asset.
    const domainMatch = /^\/([^/]+)\/?$/.exec(url.pathname);
    if (request.method === "GET" && domainMatch && domainMatch[1].includes(".")) {
      const domain = decodeURIComponent(domainMatch[1]).trim().toLowerCase();
      if (await env.DISCOVERY.get(domain)) {
        const ssrUrl = new URL(`/ssr/${encodeURIComponent(domain)}/`, url.origin);
        return handle(manifest, app, new Request(ssrUrl, request) as never, env as never, ctx as never);
      }
    }

    // Everything else is Astro: prerendered pages/data served from ASSETS, and
    // the on-demand routes (surface detail pages) rendered in this Worker.
    return handle(manifest, app, request as never, env as never, ctx as never);
  };

  return { default: { fetch: fetchHandler }, McpDurableObject };
}

export { McpDurableObject };
