// Build-time GitHub star seed for the nav badge, resolved once per process.
//
// This is the first layer of the star-count story:
//  - build-time prerender: no worker env — fetch the GitHub API directly by
//    default (one call per build, module-cached), with a 1-hour file cache.
//    If GitHub is unavailable, fall back to the newer of the stale file cache
//    and the committed seed (refreshed daily by CI) so cacheless CI builds
//    still bake a count. Set INTEGRATIONS_SKIP_GITHUB_STARS=1 to skip the
//    fetch for offline builds.
//  - worker SSR: read the baked /disc/meta.json through the ASSETS binding.
// The client-side nav enhancement then asks /api/stars.json for the runtime
// layer, which is edge-cached and falls back to this baked value.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import seed from "~/data/github-stars.json";

const REPO = "UsefulSoftwareCo/integrations";
const GITHUB_STARS_URL = `https://api.github.com/repos/${REPO}`;
const STARS_CACHE_DIR = "node_modules/.cache/integrationsdotsh";
const STARS_CACHE_FILE = `${STARS_CACHE_DIR}/github-stars.json`;
const STARS_CACHE_TTL_MS = 60 * 60 * 1000;
export const REPO_URL = `https://github.com/${REPO}`;

interface AssetsFetcher {
  fetch: (request: Request | string) => Promise<Response>;
}

let cached: Promise<number | null> | undefined;

type StarsSnapshot = { stars: number; fetchedAt: number };

function parseStarsSnapshot(data: unknown): StarsSnapshot | null {
  if (!data || typeof data !== "object") return null;
  const snapshot = data as { stars?: unknown; fetchedAt?: unknown };
  return typeof snapshot.stars === "number" && typeof snapshot.fetchedAt === "number"
    ? { stars: snapshot.stars, fetchedAt: snapshot.fetchedAt }
    : null;
}

function readStarsSeed(): StarsSnapshot | null {
  return parseStarsSnapshot(seed);
}

function newerStarsSnapshot(
  a: StarsSnapshot | null,
  b: StarsSnapshot | null,
): StarsSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  return a.fetchedAt >= b.fetchedAt ? a : b;
}

async function readStarsCache(): Promise<StarsSnapshot | null> {
  try {
    return parseStarsSnapshot(JSON.parse(await readFile(STARS_CACHE_FILE, "utf8")));
  } catch {
    return null;
  }
}

async function writeStarsCache(stars: number): Promise<void> {
  try {
    await mkdir(STARS_CACHE_DIR, { recursive: true });
    await writeFile(STARS_CACHE_FILE, JSON.stringify({ stars, fetchedAt: Date.now() }));
  } catch {
    // Cache failures should never fail the build.
  }
}

async function fetchGitHubStars(): Promise<number | null> {
  try {
    const res = await fetch(GITHUB_STARS_URL, {
      headers: { "User-Agent": "integrations.sh-build", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: unknown };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

async function fromGitHub(): Promise<number | null> {
  if (process.env.INTEGRATIONS_SKIP_GITHUB_STARS === "1") return null;
  const cache = await readStarsCache();
  if (cache && Date.now() - cache.fetchedAt < STARS_CACHE_TTL_MS) return cache.stars;
  const stars = await fetchGitHubStars();
  if (stars == null) return newerStarsSnapshot(cache, readStarsSeed())?.stars ?? null;
  await writeStarsCache(stars);
  return stars;
}

async function fromAssets(assets: AssetsFetcher): Promise<number | null> {
  try {
    const res = await assets.fetch("https://assets.local/disc/meta.json");
    if (!res.ok) return null;
    const meta = (await res.json()) as { stars?: number | null };
    return typeof meta.stars === "number" ? meta.stars : null;
  } catch {
    return null;
  }
}

export function getStars(env?: { ASSETS?: AssetsFetcher }): Promise<number | null> {
  cached ??= env?.ASSETS ? fromAssets(env.ASSETS) : fromGitHub();
  return cached;
}
