import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCatalogs, readDomainCatalogTree, writeDomainCatalogTree, type Catalog, type CatalogDomain } from "./discovered-catalog.ts";

const domain = (domainName: string, discoveredAt: string, summary = `${domainName} summary`): CatalogDomain => ({
  domain: domainName,
  summary,
  discoveredAt,
  surfaces: [
    {
      slug: "api",
      name: "API",
      type: "http",
      authStatus: "unknown",
      url: `https://${domainName}/api`,
    },
  ],
});

describe("mergeCatalogs", () => {
  test("adds new domains, updates older existing domains, preserves existing-only domains, and keeps newer existing rows", () => {
    const existing: Catalog = {
      domains: [
        domain("existing-only.com", "2026-07-01T00:00:00.000Z"),
        domain("older.com", "2026-07-01T00:00:00.000Z", "old summary"),
        domain("newer.com", "2026-07-03T00:00:00.000Z", "newer existing summary"),
      ],
    };
    const incoming = [
      domain("brand-new.com", "2026-07-02T00:00:00.000Z"),
      domain("older.com", "2026-07-02T00:00:00.000Z", "updated summary"),
      domain("newer.com", "2026-07-02T00:00:00.000Z", "stale incoming summary"),
    ];

    const merged = mergeCatalogs(existing, incoming);

    expect(merged.stats).toEqual({ new: 1, updated: 1, unchanged: 2 });
    expect(merged.catalog.domains.map((row) => row.domain)).toEqual([
      "brand-new.com",
      "existing-only.com",
      "newer.com",
      "older.com",
    ]);
    expect(merged.catalog.domains.find((row) => row.domain === "older.com")?.summary).toBe("updated summary");
    expect(merged.catalog.domains.find((row) => row.domain === "newer.com")?.summary).toBe("newer existing summary");
    expect(merged.catalog.domains.find((row) => row.domain === "existing-only.com")).toBeDefined();
  });

  test("merges aliases by canonical domain with newest row winning", () => {
    const existing: Catalog = { domains: [domain("zoom.us", "2026-07-01T00:00:00.000Z", "alias")] };
    const incoming = [domain("zoom.com", "2026-07-02T00:00:00.000Z", "canonical")];

    const merged = mergeCatalogs(existing, incoming);

    expect(merged.stats).toEqual({ new: 0, updated: 1, unchanged: 0 });
    expect(merged.catalog.domains).toHaveLength(1);
    expect(merged.catalog.domains[0]?.domain).toBe("zoom.com");
    expect(merged.catalog.domains[0]?.summary).toBe("canonical");
  });

  test("writes and reads one integrations.json file per canonical domain", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-tree-"));
    try {
      const written = writeDomainCatalogTree(dir, [
        domain("zoom.us", "2026-07-01T00:00:00.000Z", "alias"),
        domain("brand-new.com", "2026-07-02T00:00:00.000Z"),
      ]);

      expect(written).toEqual({ written: 2, changed: 2, skipped: [] });
      expect(readDomainCatalogTree(dir).domains.map((row) => row.domain)).toEqual(["brand-new.com", "zoom.us"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
