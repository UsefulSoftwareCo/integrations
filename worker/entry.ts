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
import resvgWasmModule from "@resvg/resvg-wasm/index_bg.wasm?module";
import yogaWasmModule from "satori/yoga.wasm?module";
import { apiContext, apiHandler } from "./api.ts";
import { canonicalRedirect } from "./canonical.ts";
import { sitemapSurfacesResponse } from "./sitemap-surfaces.ts";
import { discoveryDoc, discoveryKvGet } from "./discovery-doc.ts";
import { setChat, setWebBackend, discoverWithProgress, preserveSlugs } from "./operations.ts";
import { contextWeb, naiveWeb } from "../src/lib/contextdev.ts";
import { DOMAIN_ALIASES, canonicalDomain } from "../src/lib/domain-aliases.ts";
import { isJunkDomain, registrableDomain } from "../src/lib/favicon.ts";
import { isSdkNotCli } from "../src/lib/surface-classify.ts";
import { renderOgPng, type OgFonts, type OgImageData } from "../src/lib/og.tsx";
import type { Surface } from "../src/lib/surface-view.ts";
import type { Credential } from "../src/lib/surface-view.ts";
import type { EdgeCaches, Env, ExecutionContext } from "./env.ts";
import { McpDurableObject } from "./mcp-do.ts";

// Bump when detect/discover output shape or logic changes, so the edge Cache API
// (which survives deploys) stops serving results produced by the old code.
const CACHE_VERSION = "18"; // 18: search + surface API operations

// The discovery-loop model. gpt-5.4 drives the agentic tool-calling loop
// (search/sitemap/scrape/report). (Note: gpt-5.x rejects `reasoning_effort`
// alongside function tools here, so we don't set it.)
const OPENAI_MODEL = "gpt-5.4";

// Spend cap: OpenAI spend is bounded by the usage limit on the OpenAI project/key.
// To route through Cloudflare AI Gateway instead, point this at the gateway's
// OpenAI endpoint (needs "Authenticated Gateway" off, or a cf-aig-authorization token):
//   `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai/chat/completions`
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ogRuntime = { yoga: yogaWasmModule, resvg: resvgWasmModule };

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

/** Prior surfaces for a domain: the same stored-or-baseline document the domain
 * page renders, whose slugs the prerendered pages already link to. */
async function priorSurfaces(env: Env, origin: string, domain: string): Promise<Surface[]> {
  return (await discoveryDoc(env, origin, domain))?.surfaces ?? [];
}

let ogFontsPromise: Promise<OgFonts> | null = null;
const assetBuffer = async (env: Env, origin: string, path: string): Promise<ArrayBuffer> => {
  const res = await env.ASSETS.fetch(`${origin}${path}`);
  if (!res.ok) throw new Error(`missing asset: ${path}`);
  return res.arrayBuffer();
};

function ogFonts(env: Env, origin: string): Promise<OgFonts> {
  ogFontsPromise ??= Promise.all([
    assetBuffer(env, origin, "/fonts/geist-400.woff"),
    assetBuffer(env, origin, "/fonts/geist-500.woff"),
    assetBuffer(env, origin, "/fonts/geist-600.woff"),
    assetBuffer(env, origin, "/fonts/geist-mono-400.woff"),
    assetBuffer(env, origin, "/fonts/geist-mono-500.woff"),
    assetBuffer(env, origin, "/fonts/geist-mono-600.woff"),
  ]).then(([geist400, geist500, geist600, mono400, mono500, mono600]) => ({
    geist400,
    geist500,
    geist600,
    mono400,
    mono500,
    mono600,
  }));
  return ogFontsPromise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function faviconData(origin: string, domain: string): Promise<OgImageData | null> {
  const res = await fetch(`${origin}/logo/${encodeURIComponent(domain)}?sz=128`).catch(() => null);
  const contentType = res?.headers.get("content-type") ?? "";
  if (!res?.ok || !contentType.toLowerCase().startsWith("image/")) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { contentType, dataUri: `data:${contentType};base64,${bytesToBase64(bytes)}` };
}

async function ogResponse(request: Request, env: Env, ctx: ExecutionContext, cacheVersion: string): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const meta = ogMeta(url);
  if (!meta) return null;
  const started = Date.now();
  const cache = (caches as unknown as EdgeCaches).default;
  const keyUrl = new URL(url.origin + url.pathname);
  keyUrl.searchParams.set("__cv", cacheVersion);
  const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    track(env, ctx, request, "og_render", {
      kind: meta.kind,
      ...(meta.domain && { domain: meta.domain }),
      status: cached.status,
      duration_ms: Date.now() - started,
      cache_hit: true,
    });
    return cached;
  }

  const png = async () => {
    const fonts = await ogFonts(env, url.origin);
    if (url.pathname === "/og.png") {
      return renderOgPng({ kind: "home" }, fonts, ogRuntime);
    }

    const match = /^\/og\/([^/]+)(?:\/([^/]+))?\.png$/.exec(url.pathname);
    if (!match) return null;
    const domain = registrableDomain(decodeURIComponent(match[1]).trim().toLowerCase());
    if (!domain) return null;
    const doc = await discoveryDoc(env, url.origin, domain);
    if (!doc?.surfaces?.length) return null;

    const favicon = await faviconData(url.origin, domain);
    const slug = match[2] ? decodeURIComponent(match[2]) : "";
    if (!slug) {
      return renderOgPng({ kind: "domain", domain, doc, favicon }, fonts, ogRuntime);
    }

    const surface = doc.surfaces.find((s) => s.slug === slug);
    if (!surface) return null;
    return renderOgPng(
      { kind: "surface", domain, surface, credentials: (doc.credentials ?? {}) as Record<string, Credential>, favicon },
      fonts,
      ogRuntime,
    );
  };

  const body = await png();
  if (!body) {
    track(env, ctx, request, "og_render", {
      kind: meta.kind,
      ...(meta.domain && { domain: meta.domain }),
      status: 404,
      duration_ms: Date.now() - started,
      cache_hit: false,
    });
    return new Response(null, { status: 404 });
  }
  const bodyBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const cacheable = new Response(bodyBuffer, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
  track(env, ctx, request, "og_render", {
    kind: meta.kind,
    ...(meta.domain && { domain: meta.domain }),
    status: 200,
    duration_ms: Date.now() - started,
    cache_hit: false,
  });
  if (request.method === "HEAD") {
    return new Response(null, { headers: cacheable.headers });
  }
  return cacheable;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers },
  });

const truncate = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max));

function apiEndpoint(pathname: string): string | undefined {
  if (pathname === "/openapi.json") return "openapi";
  const m = /^\/api\/[^/]+\/(detect|discover|surface)\/?$/.exec(pathname);
  return m?.[1];
}

async function mcpRequestMeta(request: Request): Promise<{ method?: string; tool?: string }> {
  if (request.method !== "POST") return {};
  try {
    const body = (await request.clone().json()) as { method?: string; params?: { name?: string } };
    const method = typeof body.method === "string" ? body.method : undefined;
    const tool = method === "tools/call" && typeof body.params?.name === "string" ? body.params.name : undefined;
    return { ...(method && { method }), ...(tool && { tool }) };
  } catch {
    return {};
  }
}

function ogMeta(url: URL): { kind: "home" | "domain" | "surface"; domain?: string } | null {
  if (url.pathname === "/og.png") return { kind: "home" };
  const match = /^\/og\/([^/]+)(?:\/([^/]+))?\.png$/.exec(url.pathname);
  if (!match) return null;
  const domain = registrableDomain(decodeURIComponent(match[1]).trim().toLowerCase());
  if (!domain) return null;
  return match[2] ? { kind: "surface", domain } : { kind: "domain", domain };
}

function discoveryCounts(result: {
  surfaces?: readonly unknown[] | unknown[];
  credentials?: Readonly<Record<string, unknown>> | Record<string, unknown>;
  usedLlm?: boolean;
}) {
  return {
    surfaces_count: Array.isArray(result.surfaces) ? result.surfaces.length : 0,
    credentials_count: result.credentials ? Object.keys(result.credentials).length : 0,
    used_llm: !!result.usedLlm,
  };
}

/** Drop SDK-as-`cli` surfaces from a stored-discovery KV envelope's JSON string,
 * so the /api/{domain}/discovery endpoint matches the rendered pages. Serves the
 * value unchanged if it doesn't parse into the expected shape. */
function stripSdkFromStored(raw: string): string {
  try {
    const envelope = JSON.parse(raw) as { result?: { surfaces?: Surface[] } };
    if (envelope.result?.surfaces?.length) {
      envelope.result.surfaces = envelope.result.surfaces.filter((s) => !isSdkNotCli(s));
      return JSON.stringify(envelope);
    }
  } catch {
    /* malformed — serve as-is */
  }
  return raw;
}

async function healthz(env: Env): Promise<Response> {
  const kv = await Promise.race([
    env.DISCOVERY.get("stripe.com"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
  ])
    .then(() => "ok" as const)
    .catch(() => "slow" as const);
  const body: Record<string, unknown> = { ok: true, version: CACHE_VERSION };
  if (kv === "slow") body.kv = "slow";
  return json(body, 200, { "cache-control": "no-store" });
}

const TRAILING_SLASH_SKIP_PREFIXES = ["/api/", "/og/", "/_i/", "/logo/"];

function trailingSlashRedirect(request: Request, url: URL): Response | null {
  if (request.method !== "GET" || url.pathname.endsWith("/")) return null;
  if (TRAILING_SLASH_SKIP_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return null;
  // Page paths here are /{domain} and /{domain}/{slug} — the first segment is
  // dotted (gitlab.com), so "dot = file" is wrong. A path is page-like when
  // its first segment parses as a registrable domain and its last segment
  // isn't a file (no dot, or the whole segment IS the domain).
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!registrableDomain(first)) return null;
  if (last !== first && last.includes(".")) return null;
  const target = new URL(url);
  target.pathname = `${url.pathname}/`;
  return Response.redirect(target.toString(), 301);
}

function aliasDomainRedirect(request: Request, url: URL): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const discMatch = /^\/disc\/([^/]+)\.json$/.exec(url.pathname);
  if (discMatch) {
    const alias = decodeURIComponent(discMatch[1]).trim().toLowerCase();
    const canonical = canonicalDomain(alias);
    if (DOMAIN_ALIASES[alias] && canonical !== alias) {
      const target = new URL(url);
      target.pathname = `/disc/${encodeURIComponent(canonical)}.json`;
      return Response.redirect(target.toString(), 301);
    }
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = decodeURIComponent(segments[0]).trim().toLowerCase();
  const canonical = canonicalDomain(first);
  if (!DOMAIN_ALIASES[first] || canonical === first) return null;

  const rest = segments.slice(1).join("/");
  const trailing = url.pathname.endsWith("/") ? "/" : "";
  const target = new URL(url);
  target.pathname = `/${encodeURIComponent(canonical)}${rest ? `/${rest}${trailing}` : trailing}`;
  return Response.redirect(target.toString(), 301);
}

/** Fire-and-forget server-side PostHog capture. Browser pageviews come from
 * posthog-js (src/lib/analytics.ts); this covers the callers that never run
 * JS — agents fetching data files, MCP clients, and direct API users.
 * `apiKeys` routes the event to one or more projects (executor heartbeat is
 * dual-sent: the executor project owns the DAU series, the integrations
 * project keeps the site-traffic view). */
function track(env: Env, ctx: ExecutionContext, request: Request, event: string, properties: Record<string, unknown> = {}, apiKeys?: Array<string | undefined>): void {
  const keys = [...new Set((apiKeys ?? [env.POSTHOG_KEY]).filter((k): k is string => !!k))];
  if (keys.length === 0) return;
  const body = {
    event,
    distinct_id: request.headers.get("cf-connecting-ip") || "unknown",
    properties: {
      $process_person_profile: false,
      user_agent: request.headers.get("user-agent") || "unknown",
      country: request.headers.get("cf-ipcountry") || "unknown",
      path: new URL(request.url).pathname,
      ...properties,
    },
  };
  for (const api_key of keys) {
    ctx.waitUntil(
      fetch("https://us.i.posthog.com/i/v0/e/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key, ...body }),
      }).catch(() => {}),
    );
  }
}

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);

  const fetchHandler = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    try {
      return await handleRequest(request, env, ctx, manifest, app);
    } catch (err) {
      const message = truncate(err instanceof Error ? err.message : String(err), 200);
      const stack = truncate(err instanceof Error ? (err.stack ?? "") : "", 300);
      track(env, ctx, request, "worker_exception", { message, stack });
      throw err;
    }
  };

  return { default: { fetch: fetchHandler }, McpDurableObject };
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  manifest: SSRManifest,
  app: App,
): Promise<Response> {
    const url = new URL(request.url);
    // Host canonicalization: www / workers.dev serve 301s to the apex
    // (except /healthz, which monitors may hit on any host).
    const canonical = canonicalRedirect(request);
    if (canonical) return canonical;
    const aliasRedirect = aliasDomainRedirect(request, url);
    if (aliasRedirect) return aliasRedirect;
    if (url.pathname === "/sitemap-surfaces.xml") return sitemapSurfacesResponse();
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
      const mcpMeta = await mcpRequestMeta(request);
      track(env, ctx, request, "mcp_request", mcpMeta);
      return env.MCP.get(env.MCP.idFromName("mcp")).fetch(request);
    }

    if (url.pathname === "/healthz" && request.method === "GET") {
      return healthz(env);
    }

    // Logo proxy — the single logo source for executor clients (and anything
    // else): /logo/{domain}?theme=light|dark&sz=64. Proxies context.dev Logo
    // Link, falling back to Google's favicon service when the client id is
    // missing or the upstream errors. Logo Link's terms forbid persisting
    // images in our own storage but explicitly allow header-driven browser/CDN
    // caching, so this uses the edge Cache API with a TTL matching the
    // upstream's own 24h Cache-Control — no KV/R2.
    const logoMatch = /^\/logo\/([^/]+)\/?$/.exec(url.pathname);
    if (logoMatch) {
      const domain = registrableDomain(decodeURIComponent(logoMatch[1]).trim().toLowerCase());
      if (!domain) return json({ error: "not a public registrable domain" }, 400);
      const theme = url.searchParams.get("theme");
      const size = Math.min(Math.max(Number(url.searchParams.get("sz")) || 64, 16), 256);

      // Normalized cache key: validated domain + the params that affect bytes.
      const cache = (caches as unknown as EdgeCaches).default;
      const keyUrl = new URL(`${url.origin}/logo/${domain}`);
      if (theme === "light" || theme === "dark") keyUrl.searchParams.set("theme", theme);
      keyUrl.searchParams.set("sz", String(size));
      keyUrl.searchParams.set("__cv", CACHE_VERSION);
      const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const isImage = (r: Response) =>
        r.ok && (r.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");
      let upstream: Response | null = null;
      if (env.CONTEXT_DEV_LOGO_CLIENT_ID) {
        const logoLink = new URL("https://logos.context.dev/");
        logoLink.searchParams.set("publicClientId", env.CONTEXT_DEV_LOGO_CLIENT_ID);
        logoLink.searchParams.set("domain", domain);
        if (theme === "light" || theme === "dark") logoLink.searchParams.set("theme", theme);
        upstream = await fetch(logoLink, {
          // Access to the client id is referrer-restricted; identify as the site.
          headers: { referer: "https://integrations.sh/" },
          // Logo Link serves originals (2048px PNGs for some brands) — have
          // Cloudflare downscale to the requested size. Ignored (originals pass
          // through) when the zone doesn't have Image Resizing.
          cf: { image: { width: size, height: size, fit: "scale-down" } },
        } as RequestInit).catch(() => null);
      }
      if (!upstream || !isImage(upstream)) {
        upstream = await fetch(
          `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`,
        ).catch(() => null);
      }
      if (!upstream || !isImage(upstream)) return json({ error: "no logo found" }, 404);

      const res = new Response(upstream.body, {
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "image/png",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
        },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    if (url.pathname === "/og.png" || url.pathname.startsWith("/og/")) {
      try {
        const res = await ogResponse(request, env, ctx, CACHE_VERSION);
        if (res) return res;
      } catch (err) {
        track(env, ctx, request, "og_error", {
          path: url.pathname,
          message: truncate(err instanceof Error ? err.message : String(err), 200),
        });
      }
      return new Response(null, { status: 404 });
    }

    // Self-describe via the same discovery format the catalog indexes: point at
    // our own OpenAPI + MCP endpoint.
    // Renamed docs page — the old path may be linked/indexed.
    if (url.pathname === "/own-your-page" || url.pathname === "/own-your-page/") {
      return Response.redirect(new URL("/publishing/", url.origin).toString(), 301);
    }
    // Our own well-known documents — served from the Worker because the assets
    // layer skips dotfile paths. Content lives in public/.well-known/ for
    // provenance; these routes mirror it.
    if (["/.well-known/integrations.json", "/.well-known/mcp/server-card.json"].includes(url.pathname)) {
      const res = await env.ASSETS.fetch(url.origin + url.pathname);
      if (res.ok) return res;
      return json({ error: "not found" }, 404);
    }
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
    // last completion. The domain page reads this at render/mount and uses it
    // as the only render source. 404 when nothing has been discovered yet.
    const storedMatch = /^\/api\/([^/]+)\/discovery\/?$/.exec(url.pathname);
    if (storedMatch) {
      const domain = canonicalDomain(decodeURIComponent(storedMatch[1]));
      const raw = await discoveryKvGet(env, domain);
      // Strip client SDKs mis-typed as `cli` so this stored-discovery API agrees
      // with what the pages render. Falls back to raw if the value doesn't parse.
      const body = raw ? stripSdkFromStored(raw) : JSON.stringify({ stored: false });
      return new Response(body, {
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
      const domain = canonicalDomain(decodeURIComponent(streamMatch[1]));
      const cache = (caches as unknown as EdgeCaches).default;
      const keyUrl = new URL(url.origin + `/api/${encodeURIComponent(domain)}/discover`);
      keyUrl.searchParams.set("__cv", CACHE_VERSION);
      const cacheKey = new Request(keyUrl.toString(), { method: "GET" });

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      // Cached results are free to serve; an uncached run costs an LLM loop —
      // cap those per client IP. 429 before the stream starts.
      const cachedProbe = await cache.match(cacheKey);
      if (!cachedProbe && env.DISCOVER_LIMITER) {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.DISCOVER_LIMITER.limit({ key: ip });
        if (!success) {
          track(env, ctx, request, "discovery_ratelimited", { domain });
          return json({ error: "rate limited — try again in a minute" }, 429, { "retry-after": "60" });
        }
      }
      const producer = (async () => {
        const started = Date.now();
        try {
          const cached = await cache.match(cacheKey);
          if (cached) {
            const result = (await cached.json()) as { domain?: string; surfaces?: unknown[]; credentials?: Record<string, unknown>; usedLlm?: boolean };
            await send("done", result);
            track(env, ctx, request, "discovery_run", {
              domain,
              outcome: "cached",
              duration_ms: Date.now() - started,
              ...discoveryCounts(result),
            });
            // Backfill KV so a cache-served result still lands in durable storage.
            if (result.domain) {
              ctx.waitUntil(env.DISCOVERY.put(canonicalDomain(result.domain), JSON.stringify({ result, discoveredAt: new Date().toISOString(), model: OPENAI_MODEL })));
            }
          } else {
            const prior = await priorSurfaces(env, url.origin, domain);
            const result = await discoverWithProgress(domain, (ev) => {
              if (ev.kind === "progress") void send("progress", { message: ev.message });
              else if (ev.kind === "credential") void send("credential", { id: ev.id, credential: ev.credential });
              else if (ev.kind === "surface") void send("surface", ev.surface);
            });
            if (Array.isArray(result.surfaces)) preserveSlugs(result.surfaces as Surface[], prior);
            await send("done", result);
            track(env, ctx, request, "discovery_run", {
              domain,
              outcome: "done",
              duration_ms: Date.now() - started,
              ...discoveryCounts(result),
            });
            const toCache = new Response(JSON.stringify(result), {
              headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=86400" },
            });
            ctx.waitUntil(cache.put(cacheKey, toCache));
            // Persist durably, keyed by the normalized domain, for render-time reads.
            if (result.domain) {
              ctx.waitUntil(env.DISCOVERY.put(canonicalDomain(result.domain), JSON.stringify({ result, discoveredAt: new Date().toISOString(), model: OPENAI_MODEL })));
            }
          }
        } catch (err) {
          track(env, ctx, request, "discovery_error", {
            domain,
            message: truncate(err instanceof Error ? err.message : String(err), 200),
            duration_ms: Date.now() - started,
          });
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

    // Dynamic API (the Effect HttpApi) — catalog search, surface docs, detect,
    // discover + the OpenAPI doc.
    // Other /api/* paths (e.g. the static /api/domains.json) fall through to Astro.
    if (
      url.pathname === "/openapi.json" ||
      url.pathname === "/api/search" ||
      /^\/api\/[^/]+\/(?:detect|discover|surface)\/?$/.test(url.pathname)
    ) {
      const endpoint = apiEndpoint(url.pathname);
      const cache = (caches as unknown as EdgeCaches).default;
      // Version the cache key so a deploy that bumps CACHE_VERSION orphans stale
      // entries (the Cache API otherwise survives deploys).
      const keyUrl = new URL(request.url);
      keyUrl.searchParams.set("__cv", CACHE_VERSION);
      const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) {
        track(env, ctx, request, "api_request", { ...(endpoint && { endpoint }), cache_hit: true, status: cached.status });
        return cached;
      }
      // Uncached /discover runs the LLM loop — same per-IP cap as the stream.
      if (url.pathname.includes("/discover") && env.DISCOVER_LIMITER) {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.DISCOVER_LIMITER.limit({ key: ip });
        if (!success) {
          track(env, ctx, request, "discovery_ratelimited", { path: url.pathname });
          track(env, ctx, request, "api_request", { ...(endpoint && { endpoint }), cache_hit: false, status: 429 });
          return json({ error: "rate limited — try again in a minute" }, 429, { "retry-after": "60" });
        }
      }
      const res = await apiHandler(request, apiContext(env, url.origin));
      track(env, ctx, request, "api_request", { ...(endpoint && { endpoint }), cache_hit: false, status: res.status });
      const maxAge = url.pathname.includes("/discover") ? 86400 : url.pathname.includes("/surface") ? 60 : 3600;
      if (request.method === "GET" && (res.status === 200 || (url.pathname.includes("/surface") && res.status === 404))) {
        const out = new Response(res.clone().body, res);
        // discover runs the LLM agent — cache a day; surface matches /api/{domain}/discovery; the rest are cheap — an hour.
        out.headers.set("cache-control", `public, max-age=${maxAge}`);
        if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      }
      return res;
    }

    // Analytics on fallthrough: `hit` for executor agents, `data_fetch` for
    // any other non-browser caller pulling the machine-readable files.
    // Browser pageviews are client-side. The `hit` heartbeat doubles as the
    // executor DAU signal, so it dual-sends: executor project (canonical DAU
    // series, queried by the executor dashboards) + integrations project
    // (integrations.sh's own traffic view).
    const agent = request.headers.get("user-agent") || "unknown";
    if (agent.includes("executor")) {
      track(env, ctx, request, "hit", {}, [env.POSTHOG_EXECUTOR_KEY, env.POSTHOG_KEY]);
    } else if (!agent.includes("Mozilla") && (/\.json$/.test(url.pathname) || url.pathname.startsWith("/.well-known/"))) {
      // Browsers (the homepage fetches /api/domains.json) identify as Mozilla;
      // what's left is curl, scripts, and agents pulling the data files.
      track(env, ctx, request, "data_fetch");
    }

    // /ssr/{domain}/ is the INTERNAL render target below — never a public URL.
    // Direct hits redirect to the one canonical path.
    const ssrLeak = /^\/ssr\/([^/]+)\/?$/.exec(url.pathname);
    if (ssrLeak) {
      return Response.redirect(new URL(`/${ssrLeak[1]}/`, url.origin).toString(), 301);
    }

    const slashRedirect = trailingSlashRedirect(request, url);
    if (slashRedirect) return slashRedirect;

    // Domain page with a STORED discovery → SSR it with the map baked in
    // (src/pages/ssr/[domain].astro) instead of the prerendered asset, so
    // returning visitors don't get the idle-button flash while the island
    // fetches. One KV read per page view; a miss falls through to the asset.
    const domainMatch = /^\/([^/]+)\/?$/.exec(url.pathname);
    if (request.method === "GET" && domainMatch && domainMatch[1].includes(".")) {
      const domain = canonicalDomain(decodeURIComponent(domainMatch[1]));
      if (!isJunkDomain(domain) && await discoveryKvGet(env, domain)) {
        const ssrUrl = new URL(`/ssr/${encodeURIComponent(domain)}/`, url.origin);
        return handle(manifest, app, new Request(ssrUrl, request) as never, env as never, ctx as never);
      }
    }

    // Everything else is Astro: prerendered pages/data served from ASSETS, and
    // the on-demand routes (surface detail pages) rendered in this Worker.
    return handle(manifest, app, request as never, env as never, ctx as never);
}

export { McpDurableObject };
