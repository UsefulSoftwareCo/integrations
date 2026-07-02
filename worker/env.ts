/**
 * The Worker environment, declared once and shared by the entry, the Astro
 * pages (via Astro.locals.runtime.env), and anything else that touches a
 * binding.
 *
 * The binding interfaces are structural on purpose: this project compiles
 * src/ and worker/ under one tsconfig with the DOM lib (Astro's default), and
 * @cloudflare/workers-types redeclares Request/Response/caches in ways that
 * conflict with it. Rather than fork the compilation in two, we declare the
 * few binding methods we actually call — against DOM Request/Response, which
 * workerd accepts at runtime.
 */

export interface Fetcher {
  fetch: (request: Request | string) => Promise<Response>;
}

export interface DurableObjectStub {
  fetch: (request: Request) => Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => DurableObjectStub;
}

export interface KVNamespace {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
}

export interface ExecutionContext {
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
}

/** The edge Cache API — workerd's `caches` has a `default` cache the DOM lib
 * doesn't know about. */
export interface EdgeCaches {
  default: Cache;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Per-IP limiter for LLM discovery runs (wrangler `unsafe.bindings` ratelimit). */
  DISCOVER_LIMITER?: RateLimiter;
  ASSETS: Fetcher;
  /** PostHog project token for server-side captures (same value as the public
   * client token — it can only ingest). */
  POSTHOG_KEY?: string;
  /** PostHog token of the EXECUTOR product project. The executor-UA `hit`
   * heartbeat is the executor DAU/WAU signal, so it must land there — the
   * executor dashboards ("Executor — Stats", active machines by surface)
   * query it. Everything else goes to the integrations.sh project via
   * POSTHOG_KEY. Optional so a missing secret degrades to site-only. */
  POSTHOG_EXECUTOR_KEY?: string;
  MCP: DurableObjectNamespace;
  /** Durable per-domain store of discovery results — written on completion
   * and read at page render as the page's only surface source. */
  DISCOVERY: KVNamespace;
  /** context.dev API key (secret). When set, the discover agent reads docs via
   * context.dev's JS-rendered Markdown scrape + web search; else a naive fetch. */
  CONTEXT_DEV_API_KEY?: string;
  /** OpenAI API key (secret). Powers the discover extraction model. */
  OPENAI_API_KEY?: string;
  /** context.dev Logo Link public client id (brandLL_…) for the /logo proxy.
   * Frontend-safe by design (access is referrer-restricted upstream), but kept
   * in env so rotating it is a secret update, not a deploy. Optional: when
   * missing, /logo serves the Google favicon fallback only. */
  CONTEXT_DEV_LOGO_CLIENT_ID?: string;
}
