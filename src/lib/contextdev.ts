/**
 * Web backends for the discovery agent.
 *
 * The agent needs to *read* real doc sites and *find* the right page. Most
 * modern docs are client-rendered SPAs, so a raw fetch returns near-empty HTML.
 * context.dev solves both: `/web/scrape/markdown` renders the page and returns
 * clean Markdown, and `/web/search` finds developer/auth pages by query.
 *
 * `contextWeb(key)` is the real backend; `naiveWeb()` is a keyless fallback
 * (raw fetch + tag strip, no search) so the worker still runs without a key.
 */
import type { SearchHit, WebBackend } from "./discover.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const CTX_BASE = "https://api.context.dev/v1";
const MAX_SCRAPE_CHARS = 16_000;
const TIMEOUT_MS = 45_000;

/** context.dev-backed web tools (JS-rendered Markdown scrape + web search). */
/** Retry transient upstream pressure (429/5xx) — under fleet concurrency,
 * context.dev rate limits otherwise surface as permanent scrape failures the
 * model treats as dead ends. */
async function retrying(run: () => Promise<Response>): Promise<Response> {
  let res = await run();
  for (let attempt = 1; attempt <= 3 && (res.status === 429 || res.status >= 500); attempt++) {
    const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 1500 * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 15_000)));
    res = await run();
  }
  return res;
}

// Global politeness cap on concurrent context.dev requests, shared across all
// discovery loops in the process — bulk runs multiply per-domain parallelism,
// and their API shouldn't absorb the product of both. The cap RAMPS from a
// gentle start to peak over the first minutes of the process so context.dev's
// autoscaling can track the load instead of eating a step function.
const CTX_PEAK_CONCURRENT = 12;
const CTX_RAMP_START = 3;
const CTX_RAMP_MINUTES = 10;
const ctxProcessStart = Date.now();
function ctxMaxConcurrent(): number {
  const elapsedMin = (Date.now() - ctxProcessStart) / 60_000;
  if (elapsedMin >= CTX_RAMP_MINUTES) return CTX_PEAK_CONCURRENT;
  return Math.max(CTX_RAMP_START, Math.round(CTX_RAMP_START + (CTX_PEAK_CONCURRENT - CTX_RAMP_START) * (elapsedMin / CTX_RAMP_MINUTES)));
}
let ctxInFlight = 0;
const ctxWaiters: Array<() => void> = [];
async function ctxSlot<T>(run: () => Promise<T>): Promise<T> {
  while (ctxInFlight >= ctxMaxConcurrent()) await new Promise<void>((resolve) => ctxWaiters.push(resolve));
  ctxInFlight++;
  try {
    return await run();
  } finally {
    ctxInFlight--;
    ctxWaiters.shift()?.();
  }
}

export function contextWeb(apiKey: string, fetchImpl: FetchLike = fetch): WebBackend {
  const auth = { authorization: `Bearer ${apiKey}` };
  const withTimeout = async (fn: (signal: AbortSignal) => Promise<Response>) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(t);
    }
  };

  return {
    canSearch: true,
    async search(query: string): Promise<SearchHit[]> {
      try {
        const res = await ctxSlot(() => retrying(() =>
          withTimeout((signal) =>
            fetchImpl(`${CTX_BASE}/web/search`, {
              method: "POST",
              headers: { ...auth, "content-type": "application/json" },
              body: JSON.stringify({ query, queryFanout: false, timeoutMS: TIMEOUT_MS }),
              signal,
            }),
          ),
        ));
        if (!res.ok) return [];
        const j = (await res.json()) as { results?: Array<{ url?: string; title?: string; description?: string; relevance?: string }> };
        return (j.results ?? [])
          .filter((r) => r.url)
          .slice(0, 6)
          .map((r) => ({ url: r.url as string, title: r.title ?? "", description: r.description ?? "", relevance: r.relevance ?? "" }));
      } catch {
        return [];
      }
    },
    async scrape(url: string): Promise<string> {
      try {
        const u = `${CTX_BASE}/web/scrape/markdown?url=${encodeURIComponent(url)}&includeLinks=true`;
        const res = await ctxSlot(() => retrying(() => withTimeout((signal) => fetchImpl(u, { headers: auth, signal }))));
        if (!res.ok) return `Scrape failed (HTTP ${res.status}) for ${url}`;
        const j = (await res.json()) as { markdown?: string };
        const md = typeof j.markdown === "string" ? j.markdown.trim() : "";
        return md ? md.slice(0, MAX_SCRAPE_CHARS) : `No readable content extracted from ${url}`;
      } catch {
        return `Scrape error for ${url} (timeout or network)`;
      }
    },
    async sitemap(domain: string, urlRegex?: string): Promise<string[]> {
      try {
        const u = new URL(`${CTX_BASE}/web/scrape/sitemap`);
        u.searchParams.set("domain", domain);
        u.searchParams.set("maxLinks", "300");
        if (urlRegex) u.searchParams.set("urlRegex", urlRegex);
        const res = await ctxSlot(() => retrying(() => withTimeout((signal) => fetchImpl(u.toString(), { headers: auth, signal }))));
        if (!res.ok) return [];
        const j = (await res.json()) as { urls?: string[] };
        return Array.isArray(j.urls) ? j.urls.slice(0, 300) : [];
      } catch {
        return [];
      }
    },
  };
}

/** Keyless fallback: raw fetch + tag strip, no search/sitemap. Weak on SPA docs. */
export function naiveWeb(fetchImpl: FetchLike = fetch): WebBackend {
  return {
    canSearch: false,
    async search(): Promise<SearchHit[]> {
      return [];
    },
    async sitemap(): Promise<string[]> {
      return [];
    },
    async scrape(url: string): Promise<string> {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      try {
        const res = await fetchImpl(url, {
          redirect: "follow",
          signal: ctrl.signal,
          headers: { "user-agent": "integrations.sh-discovery/0.1 (+https://integrations.sh)", accept: "text/html,text/plain,*/*" },
        });
        const ct = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        if (!res.ok) return `HTTP ${res.status} for ${url}`;
        const text = /json|text\/plain|markdown/i.test(ct) ? raw : stripHtml(raw);
        return text.slice(0, MAX_SCRAPE_CHARS);
      } catch {
        return `Failed to fetch ${url} (timeout or network error)`;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
