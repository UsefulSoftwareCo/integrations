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
