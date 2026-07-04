import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogDomain } from "./discovered-catalog.ts";
import { writeSyncedCatalog } from "./sync-kv.ts";

function domain(domainName: string): CatalogDomain {
  return {
    discoveredAt: "2026-07-03T00:00:00.000Z",
    domain: domainName,
    summary: `${domainName} integration surfaces`,
    surfaces: [
      {
        authStatus: "unknown",
        name: "API",
        slug: "api",
        type: "http",
        url: `https://${domainName}/api`,
      },
    ],
  };
}

describe("writeSyncedCatalog", () => {
  test("continues writing catalog files when redirect alias write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-kv-alias-failure-"));
    const logs: string[] = [];
    const warnings: string[] = [];

    try {
      const result = writeSyncedCatalog({
        acceptedAliases: [{ source: "b.com", target: "c.com" }],
        incoming: [domain("b.com")],
        keysListed: 1,
        log: (message) => logs.push(message),
        outDir: dir,
        skippedInvalid: 0,
        warn: (message) => warnings.push(message),
        writeAliases: () => {
          throw new Error("injected alias validation failure");
        },
      });

      const catalogPath = join(dir, "b.com", "integrations.json");
      expect(result.aliasWriteError?.message).toBe("injected alias validation failure");
      expect(result.written).toEqual({ written: 1, changed: 1, skipped: [] });
      expect(existsSync(catalogPath)).toBe(true);
      expect(JSON.parse(readFileSync(catalogPath, "utf8")).domain).toBe("b.com");
      expect(warnings.join("\n")).toContain("failed to write aliases for b.com -> c.com");
      expect(logs.some((message) => message.includes("wrote 1 domain files"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
