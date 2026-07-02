import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebBackend } from "../../src/lib/discover.ts";
import { cachedWeb } from "./scrape-cache.ts";

const tempDirs: string[] = [];

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scrape-cache-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cachedWeb", () => {
  test("caches identical scrapes and misses on a different URL", async () => {
    let scrapeCalls = 0;
    const inner: WebBackend = {
      canSearch: true,
      async search() {
        return [];
      },
      async scrape(url: string) {
        scrapeCalls++;
        return `markdown for ${url}`;
      },
      async sitemap() {
        return [];
      },
    };

    const web = cachedWeb(inner, tempCacheDir());

    await expect(web.scrape("https://example.com/docs")).resolves.toBe("markdown for https://example.com/docs");
    await expect(web.scrape("https://example.com/docs")).resolves.toBe("markdown for https://example.com/docs");
    expect(scrapeCalls).toBe(1);
    expect(web.cacheStats).toEqual({ hits: 1, misses: 1 });

    await expect(web.scrape("https://example.com/reference")).resolves.toBe("markdown for https://example.com/reference");
    expect(scrapeCalls).toBe(2);
    expect(web.cacheStats).toEqual({ hits: 1, misses: 2 });
  });
});
