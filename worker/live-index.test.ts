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
  test("derives compact live entries from discovery surfaces and preserves zero-surface results", () => {
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
    expect(
      liveIndexEntryFromResult(
        { domain: "empty.com", summary: "No public developer integration surfaces were found.", surfaces: [] },
        "2026-07-03T00:00:00.000Z",
      ),
    ).toEqual({
      domain: "empty.com",
      summary: "No public developer integration surfaces were found.",
      kinds: [],
      discoveredAt: "2026-07-03T00:00:00.000Z",
    });
  });

  test("normalizes malformed live index rows and keeps newest per domain, including zero-surface rows", () => {
    expect(
      normalizeLiveIndex([
        { domain: "fresh.com", kinds: ["graphql"], discoveredAt: "2026-07-03T01:00:00.000Z" },
        { domain: "fresh.com", kinds: ["mcp"], discoveredAt: "2026-07-03T02:00:00.000Z" },
        { domain: "__live_index__", kinds: ["mcp"], discoveredAt: "2026-07-03T02:00:00.000Z" },
        { domain: "empty.com", kinds: [], discoveredAt: "2026-07-03T03:00:00.000Z" },
      ]),
    ).toEqual([
      { domain: "empty.com", kinds: [], discoveredAt: "2026-07-03T03:00:00.000Z" },
      { domain: "fresh.com", kinds: ["mcp"], discoveredAt: "2026-07-03T02:00:00.000Z" },
    ]);
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

  test("matches zero-surface live entries by text but not by kind filter", () => {
    const zeroSurfaceLive: LiveIndexEntry[] = [
      {
        domain: "rhys.dev",
        summary: "No public developer integration surfaces were found.",
        kinds: [],
        discoveredAt: "2026-07-03T04:00:00.000Z",
      },
    ];

    expect(appendLiveSearchResults({ q: "rhys", limit: 5 }, staticIndex, [], zeroSurfaceLive)).toEqual([
      {
        domain: "rhys.dev",
        name: "rhys.dev",
        description: "No public developer integration surfaces were found.",
        kinds: [],
        url: "https://integrations.sh/rhys.dev/",
      },
    ]);
    expect(appendLiveSearchResults({ q: "rhys", kind: "mcp", limit: 5 }, staticIndex, [], zeroSurfaceLive)).toEqual([]);
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
      [
        ...live,
        {
          domain: "rhys.dev",
          summary: "No public developer integration surfaces were found.",
          kinds: [],
          discoveredAt: "2026-07-03T04:00:00.000Z",
        },
      ],
    );

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      domain: "fresh.com",
      total: 2,
      formats: { mcp: 1, openapi: 1 },
      popularity: 0,
      devtool: false,
      description: "Fresh MCP and REST",
    });
    expect(rows[2]).toMatchObject({
      domain: "rhys.dev",
      total: 0,
      formats: {},
      popularity: 0,
      devtool: false,
      description: "No public developer integration surfaces were found.",
    });
  });
});
