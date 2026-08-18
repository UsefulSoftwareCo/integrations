import { describe, expect, test } from "bun:test";
import { apiJsonWithLiveIndex, appendLiveSearchResults, liveIndexEntryFromResult, mergeLiveApiIndex, mergeLiveDomains, normalizeLiveIndex, type LiveIndexEntry, type SearchResultRow } from "./live-index.ts";
import type { IndexRecord } from "../src/lib/data.ts";
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

  test("projects new live domains into one api.json row per surface kind", () => {
    const staticRows: IndexRecord[] = [
      {
        id: "openapi/static",
        kind: "openapi",
        slug: "static",
        name: "Static",
        description: "Static API",
        domain: "static.com",
        categories: [],
        feeds: ["curated"],
      },
    ];

    expect(mergeLiveApiIndex(staticRows, live)).toEqual([
      staticRows[0],
      {
        id: "discovered/fresh-com-mcp",
        kind: "mcp",
        slug: "fresh-com",
        name: "fresh.com",
        description: "Fresh MCP and REST",
        icon: "https://integrations.sh/logo/fresh.com",
        domain: "fresh.com",
        categories: [],
        feeds: ["discovered"],
      },
      {
        id: "discovered/fresh-com-openapi",
        kind: "openapi",
        slug: "fresh-com-openapi",
        name: "fresh.com",
        description: "Fresh MCP and REST",
        icon: "https://integrations.sh/logo/fresh.com",
        domain: "fresh.com",
        categories: [],
        feeds: ["discovered"],
      },
    ]);
  });

  test("generates a fresh api.json envelope from the static asset and live index", async () => {
    const staticRows: IndexRecord[] = [
      {
        id: "openapi/static",
        kind: "openapi",
        slug: "static",
        name: "Static",
        description: "Static API",
        domain: "static.com",
        categories: [],
        feeds: ["curated"],
      },
    ];
    const env = {
      ASSETS: {
        fetch: async () => new Response(JSON.stringify({ version: 1, generatedAt: "2020-01-01T00:00:00.000Z", data: staticRows })),
      },
      DISCOVERY: {
        get: async () => JSON.stringify(live),
        put: async () => {},
      },
    };

    const response = await apiJsonWithLiveIndex(env, "https://integrations.sh");
    const body = (await response.json()) as { generatedAt: string; data: IndexRecord[] };

    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(body.generatedAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(body.data).toHaveLength(3);
  });
});
