import { describe, expect, test } from "bun:test";
import { buildDiscoveredEntries, buildSearchIndex } from "./normalize.ts";

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
