import type { APIRoute } from "astro";
import type { EdgeCaches, Fetcher } from "../../../worker/env.ts";

// Runtime GitHub star endpoint for the nav badge.
//
// The build bakes an initial value into /disc/meta.json from github.ts (using
// the 1-hour file cache and the CI-refreshed committed seed as fallback). This
// Worker-only route keeps the displayed value current after deploy: edge cache
// first, live GitHub fetch second, and the baked /disc/meta.json value if
// GitHub fails or times out.

export const prerender = false;

const GITHUB_STARS_URL = "https://api.github.com/repos/UsefulSoftwareCo/integrations";
const LONG_CACHE_CONTROL = "public, max-age=3600, s-maxage=3600";
const SHORT_CACHE_CONTROL = "public, max-age=300, s-maxage=300";

type Runtime = App.Locals["runtime"];

function jsonResponse(stars: number | null, cacheControl: string): Response {
  return new Response(JSON.stringify({ stars }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

function edgeCache(): Cache | null {
  return (globalThis.caches as unknown as EdgeCaches | undefined)?.default ?? null;
}

async function cachePut(runtime: Runtime, cache: Cache, key: Request, response: Response): Promise<void> {
  const put = cache.put(key, response.clone()).catch(() => undefined);
  if (runtime?.ctx.waitUntil) runtime.ctx.waitUntil(put);
  else await put;
}

async function fetchGitHubStars(): Promise<number | null> {
  try {
    const res = await fetch(GITHUB_STARS_URL, {
      headers: { "User-Agent": "integrations.sh-runtime", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: unknown };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

async function fromAssets(assets?: Fetcher): Promise<number | null> {
  try {
    const res = await assets?.fetch("https://assets.local/disc/meta.json");
    if (!res?.ok) return null;
    const meta = (await res.json()) as { stars?: number | null };
    return typeof meta.stars === "number" ? meta.stars : null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const cache = edgeCache();
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  const runtime = locals.runtime;
  const liveStars = await fetchGitHubStars();
  const response =
    liveStars == null
      ? jsonResponse(await fromAssets(runtime?.env.ASSETS), SHORT_CACHE_CONTROL)
      : jsonResponse(liveStars, LONG_CACHE_CONTROL);

  if (cache) await cachePut(runtime, cache, cacheKey, response);
  return response;
};
