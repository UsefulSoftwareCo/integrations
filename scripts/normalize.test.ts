import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyProviderIds,
  assembleRecords,
  buildCuratedEntries,
  buildDiscoveredEntries,
  buildIndex,
  buildSearchIndex,
  withheldDiscoveredMcp,
} from "./normalize.ts";
import { denylistEntries } from "../src/lib/catalog-denylist.ts";
import type { Integration } from "../src/lib/types.ts";

describe("normalize discovered zero-surface domains", () => {
  test("threads empty and all-filtered discovered domains into the search index without fake kinds", () => {
    const discovered = buildDiscoveredEntries(
      {
        domains: [
          {
            domain: "rhys.dev",
            summary: "No public developer integration surfaces were found.",
            description: "Personal site for Rhys Sullivan.",
            surfaces: [],
          },
          {
            domain: "sdk-only.dev",
            summary: "SDK-only catalog entry.",
            surfaces: [
              {
                slug: "javascript-sdk",
                name: "JavaScript SDK",
                type: "cli",
                authStatus: "unknown",
                packages: [{ registryType: "npm", identifier: "@sdk-only/client" }],
              },
            ],
          },
        ],
      },
      new Set(),
      new Set(),
      new Set(),
    );

    expect(discovered.records).toEqual([]);
    expect(discovered.zeroSurfaceDomains).toEqual([
      { domain: "rhys.dev", description: "Personal site for Rhys Sullivan." },
      { domain: "sdk-only.dev", description: "SDK-only catalog entry." },
    ]);
    expect(buildSearchIndex([], discovered.zeroSurfaceDomains)).toEqual([
      {
        domain: "rhys.dev",
        description: "Personal site for Rhys Sullivan.",
        kinds: [],
        devtool: false,
        popularity: 0,
        total: 0,
      },
      {
        domain: "sdk-only.dev",
        description: "SDK-only catalog entry.",
        kinds: [],
        devtool: false,
        popularity: 0,
        total: 0,
      },
    ]);
  });
});

describe("standalone product rows", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "x",
    kind: "openapi" as const,
    slug: "x",
    standalone: undefined as boolean | undefined,
    name: "x",
    description: "",
    url: undefined,
    icon: undefined,
    domain: "graph.microsoft.com",
    categories: [],
    feeds: ["curated"],
    popularity: undefined,
    devtool: undefined,
    connectUrl: undefined,
    scopes: undefined,
    ...over,
  });

  test("standalone records keep their own search row instead of collapsing per kind", () => {
    const index = buildSearchIndex([
      row({
        id: "curated/outlook-mail",
        slug: "outlook-mail",
        standalone: true,
        name: "Outlook Mail",
        description: "Outlook email over Microsoft Graph.",
        connectUrl: "https://integrations.sh/specs/microsoft-graph/mail.yaml",
      }),
      row({
        id: "curated/outlook-calendar",
        slug: "outlook-calendar",
        standalone: true,
        name: "Outlook Calendar",
        description: "Outlook calendars over Microsoft Graph.",
        connectUrl: "https://integrations.sh/specs/microsoft-graph/calendar.yaml",
      }),
    ] as never);

    expect(index).toHaveLength(2);
    expect(index.map((entry) => entry.name)).toEqual(["Outlook Mail", "Outlook Calendar"]);
    expect(index.every((entry) => entry.domain === "graph.microsoft.com")).toBe(true);
    expect(index.map((entry) => entry.surfaces?.[0]?.slug)).toEqual(["outlook-mail", "outlook-calendar"]);
  });

  test("a zero-surface report for the domain does not add an empty row next to its products", () => {
    const index = buildSearchIndex(
      [row({ id: "curated/outlook-mail", slug: "outlook-mail", standalone: true, name: "Outlook Mail" })] as never,
      [{ domain: "graph.microsoft.com", description: "nothing here" }],
    );
    expect(index).toHaveLength(1);
    expect(index[0]?.name).toBe("Outlook Mail");
  });
});

describe("rejected domains never reach the search index", () => {
  test("a denylisted domain and a junk hosting host are both dropped", () => {
    const denylisted = denylistEntries()[0]!.domain;
    const index = buildSearchIndex(
      [],
      [
        { domain: "synthetic-fixture.com", description: "kept" },
        { domain: denylisted, description: "rejected by the denylist" },
        { domain: "synthetic-fixture.vercel.app", description: "someone's deployment" },
      ],
    );

    expect(index.map((entry) => entry.domain)).toEqual(["synthetic-fixture.com"]);
  });
});

describe("provider IDs", () => {
  test("stamps mapped records and leaves the rest unset", () => {
    const recs = [
      { id: "mcp/a", kind: "mcp", slug: "a", name: "A", description: "", categories: [], feeds: ["claude"], raw: {} },
      { id: "mcp/b", kind: "mcp", slug: "b", name: "B", description: "", categories: [], feeds: ["claude"], raw: {} },
    ] as never;
    const out = applyProviderIds(recs, new Map([["mcp/a", "a.com/mcp"], ["mcp/gone", "gone.com/mcp"]]));
    expect(out.map((r) => r.providerId)).toEqual(["a.com/mcp", undefined]);
  });
});

// ── Curated MCP entries vs hosted endpoints ─────────────────────────────────
// Local fixtures only: nothing here signs in anywhere or opens an MCP session.

const noFeeds = { mcp: [], openapi: [], graphql: [], cli: [] };
const DOMAIN = "synthetic-mail.com";
const HOSTED = "https://mcp.synthetic-mail.com/mcp";

/** The shape curated/resend.json had: an MCP entry with only a local install. */
const localOnlyCurated = {
  slug: "synthetic-mail",
  name: "Synthetic Mail",
  description: "Email API.",
  domain: DOMAIN,
  interfaces: [
    { format: "mcp", name: "Synthetic MCP", auth: "api_key", install: "npx -y synthetic-mcp" },
    { format: "openapi", name: "Synthetic REST", spec: `https://${DOMAIN}/openapi.yaml`, auth: "api_key" },
  ],
};

const discoveredDomain = (mcpUrl: string | undefined) => ({
  domain: DOMAIN,
  summary: "Email API.",
  description: "Email API.",
  surfaces: [
    { slug: "rest", name: "REST", type: "http" as const, url: `https://api.${DOMAIN}`, spec: `https://${DOMAIN}/spec.yaml`, authStatus: "required" as const },
    { slug: "mcp", name: "MCP", type: "mcp" as const, ...(mcpUrl ? { url: mcpUrl } : {}), authStatus: "required" as const },
    { slug: "cli", name: "CLI", type: "cli" as const, command: "synthetic", authStatus: "required" as const },
  ],
});

const unrelatedDomain = {
  domain: "synthetic-other.com",
  summary: "Another API.",
  surfaces: [
    { slug: "mcp", name: "MCP", type: "mcp" as const, url: "https://mcp.synthetic-other.com/mcp", authStatus: "required" as const },
    { slug: "rest", name: "REST", type: "http" as const, url: "https://api.synthetic-other.com", authStatus: "required" as const },
  ],
};

const recordsFor = (records: Integration[], domain: string, kind: string) =>
  records.filter((r) => r.kind === kind && buildIndex([r])[0]?.domain === domain);

describe("curated MCP interface selection", () => {
  test("a hosted MCP interface listed after a local one is the one published", () => {
    const records = buildCuratedEntries([
      {
        ...localOnlyCurated,
        interfaces: [
          ...localOnlyCurated.interfaces,
          { format: "mcp", name: "Synthetic MCP (hosted)", endpoint: HOSTED, auth: "oauth" },
        ],
      },
    ]);

    const mcp = records.filter((r) => r.kind === "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.mcp?.remoteUrl).toBe(HOSTED);
    expect(mcp[0]!.mcp?.authTypes).toEqual(["oauth"]);
    // The kind keeps its listing position, so slugs do not shift.
    expect(records.map((r) => r.slug)).toEqual(["synthetic-mail-com", "synthetic-mail-com-openapi"]);
  });

  test("an unusable hosted endpoint does not displace the local entry", () => {
    const records = buildCuratedEntries([
      {
        ...localOnlyCurated,
        interfaces: [
          ...localOnlyCurated.interfaces,
          { format: "mcp", name: "Placeholder", endpoint: "https://{tenant}.synthetic-mail.com/mcp", auth: "oauth" },
        ],
      },
    ]);
    const mcp = records.filter((r) => r.kind === "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.mcp?.remoteUrl).toBeUndefined();
    expect(mcp[0]!.mcp?.authTypes).toEqual(["api_key"]);
  });

  test("other kinds keep first-listed-wins", () => {
    const records = buildCuratedEntries([
      {
        domain: DOMAIN,
        interfaces: [
          { format: "openapi", name: "First", docs: `https://${DOMAIN}/docs` },
          { format: "openapi", name: "Second", spec: `https://${DOMAIN}/openapi.yaml` },
        ],
      },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.openapi?.specUrl).toBeUndefined();
    expect(records[0]!.openapi?.docsUrl).toBe(`https://${DOMAIN}/docs`);
  });
});

describe("Resend hosted MCP", () => {
  const resend = JSON.parse(readFileSync(join(import.meta.dir, "..", "curated", "resend.json"), "utf8"));
  // Mirrors domains/resend.com/integrations.json.
  const discoveredResend = {
    domain: "resend.com",
    summary: "Resend email API.",
    surfaces: [
      { slug: "resend-rest-api-2", name: "Resend REST API", type: "http" as const, url: "https://api.resend.com", spec: "https://resend.com/openapi.yaml", authStatus: "required" as const },
      { slug: "resend-mcp", name: "Resend MCP", type: "mcp" as const, url: "https://mcp.resend.com/mcp", authStatus: "required" as const },
      { slug: "resend-cli", name: "Resend CLI", type: "cli" as const, command: "resend", authStatus: "required" as const },
    ],
  };

  test("the curated record publishes the hosted endpoint with OAuth + API-key auth, once", () => {
    const { records, warnings } = assembleRecords(buildCuratedEntries([resend]), noFeeds, { domains: [discoveredResend] });

    expect(warnings).toEqual([]);
    const mcp = recordsFor(records, "resend.com", "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.feeds).toEqual(["curated"]);
    expect(mcp[0]!.mcp?.remoteUrl).toBe("https://mcp.resend.com/mcp");
    expect(recordsFor(records, "resend.com", "openapi")).toHaveLength(1);

    const rows = buildSearchIndex(buildIndex(records)).filter((row) => row.domain === "resend.com");
    expect(rows).toHaveLength(1);
    const surface = rows[0]!.surfaces?.find((s) => s.kind === "mcp");
    expect(surface?.url).toBe("https://mcp.resend.com/mcp");
    expect(surface?.auth?.kind).toBe("mixed");
    expect(surface?.auth?.header).toBe("Authorization: Bearer {re_key}");
    expect(surface?.auth?.note).toContain("OAuth");
    // The local stdio option stays discoverable alongside the hosted one.
    expect(surface?.auth?.note).toContain("npx -y resend-mcp");
  });

  test("the curated file keeps the local stdio interface", () => {
    const local = resend.interfaces.find((i: { format: string; install?: string }) => i.format === "mcp" && i.install);
    expect(local?.install).toContain("npx -y resend-mcp");
    expect(local?.endpoint).toBeUndefined();
  });
});

describe("endpoint-less curated MCP entries", () => {
  test("cannot silently suppress a discovered hosted endpoint", () => {
    const { records, warnings } = assembleRecords(buildCuratedEntries([localOnlyCurated]), noFeeds, {
      domains: [discoveredDomain(HOSTED)],
    });

    const mcp = recordsFor(records, DOMAIN, "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.feeds).toEqual(["discovered"]);
    expect(mcp[0]!.mcp?.remoteUrl).toBe(HOSTED);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("curated/synthetic-mail-com-mcp");
    expect(warnings[0]).toContain(HOSTED);
    // Only the open MCP slot is filled: the curated API still wins, and the
    // domain's other discovered surfaces stay out as before.
    const openapi = recordsFor(records, DOMAIN, "openapi");
    expect(openapi.map((r) => r.feeds)).toEqual([["curated"]]);
    expect(recordsFor(records, DOMAIN, "cli")).toHaveLength(0);
  });

  test("a feed's hosted endpoint fills the slot ahead of discovery", () => {
    const feed: Integration = {
      id: "mcp/synthetic",
      kind: "mcp",
      slug: "synthetic",
      name: "Synthetic",
      description: "",
      categories: [],
      feeds: ["claude"],
      mcp: { remoteUrl: "https://feed.synthetic-mail.com/mcp" },
      raw: {},
    };
    const { records, warnings } = assembleRecords(
      buildCuratedEntries([localOnlyCurated]),
      { ...noFeeds, mcp: [feed] },
      { domains: [discoveredDomain(HOSTED)] },
    );

    const mcp = recordsFor(records, DOMAIN, "mcp");
    expect(mcp.map((r) => r.id)).toEqual(["mcp/synthetic"]);
    expect(warnings).toHaveLength(1);
  });

  test("stays when no other source has a usable endpoint", () => {
    for (const url of [undefined, "https://{tenant}.synthetic-mail.com/mcp", "http://localhost:3000/mcp"]) {
      const { records, warnings } = assembleRecords(buildCuratedEntries([localOnlyCurated]), noFeeds, {
        domains: [discoveredDomain(url)],
      });
      const mcp = recordsFor(records, DOMAIN, "mcp");
      expect(mcp).toHaveLength(1);
      expect(mcp[0]!.feeds).toEqual(["curated"]);
      expect(warnings).toEqual([]);
    }
  });

  test("a curated entry with an endpoint still owns its slot, and unrelated domains are untouched", () => {
    const curated = buildCuratedEntries([
      {
        ...localOnlyCurated,
        interfaces: [{ format: "mcp", name: "Hosted", endpoint: "https://curated.synthetic-mail.com/mcp", auth: "oauth" }],
      },
    ]);
    const { records, warnings } = assembleRecords(curated, noFeeds, {
      domains: [discoveredDomain(HOSTED), unrelatedDomain],
    });

    expect(warnings).toEqual([]);
    const mcp = recordsFor(records, DOMAIN, "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.mcp?.remoteUrl).toBe("https://curated.synthetic-mail.com/mcp");
    expect(records.filter((r) => r.feeds.includes("discovered")).map((r) => r.id)).toEqual([
      "discovered/synthetic-other-com-mcp",
      "discovered/synthetic-other-com-openapi",
    ]);
  });
});

// ── Discovered MCP surfaces: one per domain, and the usable one ─────────────

const mcpSurface = (slug: string, url?: string, authStatus: "none" | "required" | "unknown" = "required") => ({
  slug,
  name: slug,
  type: "mcp" as const,
  ...(url ? { url } : {}),
  authStatus,
});
const discoveredOnly = (domain: string, surfaces: ReturnType<typeof mcpSurface>[]) => ({
  domain,
  summary: `${domain} fixture`,
  surfaces: [
    { slug: "rest", name: "REST", type: "http" as const, url: `https://api.${domain}`, authStatus: "required" as const },
    ...surfaces,
  ],
});
const mcpOf = (records: Integration[], domain: string) =>
  records.filter((r) => r.kind === "mcp" && (r.raw.discovered as { domain?: string } | undefined)?.domain === domain);

describe("discovered MCP surface selection", () => {
  test("a hosted endpoint listed after an endpoint-less or templated one is published", () => {
    // Shapes of domains/commercelayer.io, domains/langchain.com and domains/algolia.com.
    const { records } = assembleRecords([], noFeeds, {
      domains: [
        discoveredOnly("synthetic-commerce.com", [
          mcpSurface("docs-mcp", undefined, "none"),
          mcpSurface("core-mcp", "https://core-mcp.synthetic-commerce.com/mcp"),
          mcpSurface("metrics-mcp", "https://metrics-mcp.synthetic-commerce.com/mcp"),
        ]),
        discoveredOnly("synthetic-search.com", [
          mcpSurface("public-mcp", "https://{APP_ID}.synthetic-search.net/mcp/1/{UNIQ_ID}/mcp", "none"),
          mcpSurface("productivity-mcp", "https://mcp.synthetic-search.com/mcp"),
        ]),
      ],
    });

    expect(mcpOf(records, "synthetic-commerce.com").map((r) => r.mcp?.remoteUrl)).toEqual([
      "https://core-mcp.synthetic-commerce.com/mcp",
    ]);
    expect(mcpOf(records, "synthetic-search.com").map((r) => r.mcp?.remoteUrl)).toEqual([
      "https://mcp.synthetic-search.com/mcp",
    ]);
    // The REST record and the domain's slugs are unaffected.
    expect(records.filter((r) => r.kind === "openapi").map((r) => r.slug)).toEqual([
      "synthetic-commerce-com-openapi",
      "synthetic-search-com-openapi",
    ]);
  });

  test("the first listed hosted endpoint still wins, and an all-unusable domain still publishes no MCP", () => {
    const { records } = assembleRecords([], noFeeds, {
      domains: [
        discoveredOnly("synthetic-first.com", [
          mcpSurface("a", "https://a.synthetic-first.com/mcp"),
          mcpSurface("b", "https://b.synthetic-first.com/mcp"),
        ]),
        discoveredOnly("synthetic-none.com", [
          mcpSurface("docs", undefined, "none"),
          mcpSurface("local", "http://localhost:3000/mcp"),
        ]),
      ],
    });
    expect(mcpOf(records, "synthetic-first.com").map((r) => r.mcp?.remoteUrl)).toEqual(["https://a.synthetic-first.com/mcp"]);
    expect(mcpOf(records, "synthetic-none.com")).toEqual([]);
  });

  test("a promoted endpoint never becomes a second card for one another row already publishes", () => {
    // domotz.app lists an unusable endpoint first, then domotz.com's own.
    const shared = "https://mcp.synthetic-net.com/mcp";
    const { records } = assembleRecords([], noFeeds, {
      domains: [
        discoveredOnly("synthetic-net.app", [mcpSurface("old", "https://{tenant}.synthetic-net.app/mcp"), mcpSurface("documented", shared)]),
        discoveredOnly("synthetic-net.com", [mcpSurface("mcp", shared)]),
        // Pre-existing duplicates (both first-listed) are left exactly as they were.
        discoveredOnly("synthetic-twin-a.com", [mcpSurface("mcp", "https://mcp.synthetic-twin.com/mcp")]),
        discoveredOnly("synthetic-twin-b.com", [mcpSurface("mcp", "https://mcp.synthetic-twin.com/mcp")]),
      ],
    });
    const byUrl = (url: string) => records.filter((r) => r.kind === "mcp" && r.mcp?.remoteUrl === url);
    expect(byUrl(shared).map((r) => (r.raw.discovered as { domain: string }).domain)).toEqual(["synthetic-net.com"]);
    expect(byUrl("https://mcp.synthetic-twin.com/mcp")).toHaveLength(2);
  });
});

describe("withheld discovered MCP endpoints", () => {
  test("a hosted endpoint for a domain another source covers is reported, not published", () => {
    // apis.guru covers synthetic-api.com with a spec; discovery also found its MCP server.
    const spec: Integration = {
      id: "openapi/synthetic-api-com",
      kind: "openapi",
      slug: "synthetic-api-com",
      name: "Synthetic API",
      description: "",
      categories: [],
      feeds: ["apis-guru"],
      openapi: { provider: "synthetic-api.com", version: "1", specUrl: "https://synthetic-api.com/openapi.json", openapiVer: "3.0.0" },
      raw: {},
    };
    const legacySpec: Integration = {
      ...spec,
      id: "openapi/synthetic-legacy-com",
      slug: "synthetic-legacy-com",
      openapi: { ...spec.openapi!, provider: "synthetic-legacy.com" },
    };
    const catalog = {
      domains: [
        discoveredOnly("synthetic-api.com", [mcpSurface("mcp", "https://mcp.synthetic-api.com/mcp")]),
        // Already published under the vendor's current domain: not withheld.
        discoveredOnly("synthetic-legacy.com", [mcpSurface("mcp", "https://mcp.synthetic-new.com/mcp")]),
        discoveredOnly("synthetic-new.com", [mcpSurface("mcp", "https://mcp.synthetic-new.com/mcp")]),
      ],
    };
    const { records, withheldMcp } = assembleRecords([], { ...noFeeds, openapi: [spec, legacySpec] }, catalog);

    expect(records.filter((r) => r.kind === "mcp").map((r) => r.mcp?.remoteUrl)).toEqual(["https://mcp.synthetic-new.com/mcp"]);
    expect(withheldMcp).toEqual([{ domain: "synthetic-api.com", url: "https://mcp.synthetic-api.com/mcp" }]);
    // Nothing to report once the domain has an MCP surface of its own.
    const ownMcp: Integration = { ...spec, id: "mcp/x", kind: "mcp", openapi: undefined, mcp: { remoteUrl: "https://other.synthetic-api.com/mcp" } };
    expect(withheldDiscoveredMcp([...records, ownMcp], catalog)).toEqual([]);
  });
});

describe("MCP overrides correcting feed URLs", () => {
  // The OpenAI directory lists Deel's staging host and AppDeploy's previous
  // host; the vendors document these instead.
  const override = (slug: string) =>
    JSON.parse(readFileSync(join(import.meta.dir, "..", "overrides", "mcp", `${slug}.json`), "utf8"));

  test("Deel points at its documented production endpoint", () => {
    expect(override("deel").mcp.remoteUrl).toBe("https://api.letsdeel.com/mcp");
  });

  test("AppDeploy points at its documented production server", () => {
    expect(override("appdeploy").mcp.remoteUrl).toBe("https://api-v2.appdeploy.ai/mcp");
  });
});
