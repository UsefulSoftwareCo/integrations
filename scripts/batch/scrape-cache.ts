import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SearchHit, WebBackend } from "../../src/lib/discover.ts";

export type ScrapeCacheStats = {
  hits: number;
  misses: number;
};

export type CachedWebBackend = WebBackend & {
  readonly cacheDir: string;
  readonly cacheStats: ScrapeCacheStats;
};

type CacheRecord<T> = {
  when: string;
  url?: string;
  query?: string;
  value: T;
};

const DEFAULT_CACHE_DIR = fileURLToPath(new URL("./scrape-cache/", import.meta.url));

function cacheKey(method: string, target: string): string {
  return createHash("sha256").update(`${method}\0${target}`).digest("hex");
}

function cachePath(dir: string, method: string, target: string): string {
  return join(dir, `${method}-${cacheKey(method, target)}.json`);
}

async function readCached<T>(path: string, stats: ScrapeCacheStats): Promise<T | undefined> {
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as CacheRecord<T>;
    stats.hits++;
    return record.value;
  } catch {
    stats.misses++;
    return undefined;
  }
}

async function writeCached<T>(path: string, record: CacheRecord<T>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    /* Cache persistence must not change discovery behavior. */
  }
}

export function cachedWeb(inner: WebBackend, dir = DEFAULT_CACHE_DIR): CachedWebBackend {
  const cacheStats: ScrapeCacheStats = { hits: 0, misses: 0 };

  return {
    canSearch: inner.canSearch,
    cacheDir: dir,
    cacheStats,
    async search(query: string): Promise<SearchHit[]> {
      const path = cachePath(dir, "search", query);
      const cached = await readCached<SearchHit[]>(path, cacheStats);
      if (cached) return cached;
      const value = await inner.search(query);
      await writeCached(path, { when: new Date().toISOString(), query, value });
      return value;
    },
    async scrape(url: string): Promise<string> {
      const path = cachePath(dir, "scrape", url);
      const cached = await readCached<string>(path, cacheStats);
      if (cached !== undefined) return cached;
      const value = await inner.scrape(url);
      await writeCached(path, { when: new Date().toISOString(), url, value });
      return value;
    },
    async sitemap(domain: string, urlRegex?: string): Promise<string[]> {
      const query = urlRegex ? `${domain} ${urlRegex}` : domain;
      const path = cachePath(dir, "sitemap", `${domain}\0${urlRegex ?? ""}`);
      const cached = await readCached<string[]>(path, cacheStats);
      if (cached) return cached;
      const value = await inner.sitemap(domain, urlRegex);
      await writeCached(path, { when: new Date().toISOString(), query, value });
      return value;
    },
  };
}
