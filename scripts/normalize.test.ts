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
