import { describe, expect, test } from "bun:test";
import { appendLiveSearchResults, liveIndexEntryFromResult, mergeLiveDomains, normalizeLiveIndex, type LiveIndexEntry, type SearchResultRow } from "./live-index.ts";
import type { SearchIndexEntry } from "../src/lib/search-index.ts";

const staticIndex: SearchIndexEntry[] = [
  { domain: "static.com", description: "Static API", kinds: ["openapi"], devtool: false, popularity: 10, total: 1 },
];

const live: LiveIndexEntry[] = [
  { domain: "fresh.com", summary: "Fresh MCP and REST", kinds: ["mcp", "openapi"], discoveredAt: "2026-07-03T02:00:00.000Z" },
  { domain: "static.com", summary: "Already static", kinds: ["graphql"], discoveredAt: "2026-07-03T03:00:00.000Z" },
];

describe("live index", () => {
  test("derives compact live entries from discovery surfaces and skips empty results", () => {
    expect(
      liveIndexEntryFromResult(
        {
          domain: "Example.COM",
          summary: "Example surfaces",
          surfaces: [
            { type: "http", name: "REST" },
            { type: "mcp", name: "MCP" },
            { type: "cli", name: "Node SDK" },
          ],
        },
        "2026-07-03T00:00:00.000Z",
      ),
    ).toEqual({
      domain: "example.com",
      summary: "Example surfaces",
      kinds: ["mcp", "openapi"],
      discoveredAt: "2026-07-03T00:00:00.000Z",
    });
    expect(liveIndexEntryFromResult({ domain: "empty.com", surfaces: [] }, "2026-07-03T00:00:00.000Z")).toBeNull();
  });

  test("normalizes malformed live index rows and keeps newest per domain", () => {
    expect(
      normalizeLiveIndex([
        { domain: "fresh.com", kinds: ["graphql"], discoveredAt: "2026-07-03T01:00:00.000Z" },
        { domain: "fresh.com", kinds: ["mcp"], discoveredAt: "2026-07-03T02:00:00.000Z" },
        { domain: "__live_index__", kinds: ["mcp"], discoveredAt: "2026-07-03T02:00:00.000Z" },
        { domain: "bad.com", kinds: [], discoveredAt: "2026-07-03T02:00:00.000Z" },
      ]),
    ).toEqual([{ domain: "fresh.com", kinds: ["mcp"], discoveredAt: "2026-07-03T02:00:00.000Z" }]);
  });

  test("appends matching live search results after static results and filters static domains", () => {
    const staticResults: SearchResultRow[] = [
      {
        domain: "static.com",
        name: "static.com",
        description: "Static API",
        kinds: ["openapi"],
        url: "https://integrations.sh/static.com/",
      },
    ];

    expect(appendLiveSearchResults({ q: "fresh", limit: 5 }, staticIndex, staticResults, live)).toEqual([
      staticResults[0],
      {
        domain: "fresh.com",
        name: "fresh.com",
        description: "Fresh MCP and REST",
        kinds: ["mcp", "openapi"],
        url: "https://integrations.sh/fresh.com/",
      },
    ]);
    expect(appendLiveSearchResults({ q: "fresh", kind: "graphql", limit: 5 }, staticIndex, [], live)).toEqual([]);
  });

  test("appends homepage domain rows with popularity-zero defaults", () => {
    const rows = mergeLiveDomains(
      [
        {
          domain: "static.com",
          icon: null,
          total: 1,
          formats: { openapi: 1 },
          popularity: 10,
          devtool: false,
          description: "Static API",
        },
      ],
      live,
    );

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      domain: "fresh.com",
      total: 2,
      formats: { mcp: 1, openapi: 1 },
      popularity: 0,
      devtool: false,
      description: "Fresh MCP and REST",
    });
  });
});
