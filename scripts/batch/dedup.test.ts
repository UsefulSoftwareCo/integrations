import { describe, expect, test } from "bun:test";
import { dedupSurfaces, dedupSurfacesWithReport, surfaceDedupKey } from "./dedup.ts";

describe("dedupSurfaces", () => {
  test("collapses mintlify-shaped duplicate MCP and HTTP spec surfaces", () => {
    const raw = {
      domain: "mintlify.com",
      summary: "Mintlify exposes docs automation surfaces.",
      credentials: [
        { id: "mint_oauth", type: "oauth2", label: "Mintlify OAuth", generateUrl: "https://app.mintlify.com/oauth/apps", setup: "Create an app.", fields: null },
        { id: "mint_oauth_dup", type: "oauth2", label: "Mintlify OAuth", generateUrl: "https://app.mintlify.com/oauth/apps/", setup: "Create an app with the same URL.", fields: null },
      ],
      surfaces: [
        {
          type: "mcp",
          name: "Mintlify MCP",
          url: "https://mintlify.com/mcp/",
          docs: "https://mintlify.com/docs/mcp",
          basis: { via: "detected", signal: "mcp:initialize", verifiedAt: null },
          auth: { status: "unknown" },
          transports: ["streamable-http"],
          requiredHeaders: null,
          variables: null,
          notes: null,
        },
        {
          type: "mcp",
          name: "Mint MCP Server",
          url: "https://mintlify.com/mcp",
          docs: null,
          basis: { via: "detected", signal: "mcp:server-card", verifiedAt: null },
          auth: {
            status: "required",
            entries: [
              {
                use: [{ id: "mint_oauth_dup", mechanics: { source: "well-known" } }],
                basis: { via: "detected", signal: "oauth-protected-resource", verifiedAt: null },
              },
            ],
          },
          transports: ["streamable-http"],
          requiredHeaders: null,
          variables: null,
          notes: "Self-onboarding.",
        },
        {
          type: "http",
          name: "Mintlify REST API",
          spec: "https://x.com/openapi.json",
          url: "https://api.mintlify.com",
          docs: null,
          basis: { via: "detected", signal: "openapi:schema", verifiedAt: null },
          auth: { status: "unknown" },
          requiredHeaders: null,
          variables: null,
          notes: null,
        },
        {
          type: "http",
          name: "Mintlify OpenAPI",
          spec: "https://x.com/openapi.yaml",
          url: null,
          docs: "https://mintlify.com/docs/api-reference",
          basis: { via: "detected", signal: "api-catalog", verifiedAt: null },
          auth: { status: "none", basis: { via: "discovered", evidence: ["https://mintlify.com/docs/api-reference"] } },
          requiredHeaders: null,
          variables: null,
          notes: null,
        },
      ],
    };

    const { result, collapses } = dedupSurfacesWithReport(raw);
    expect(result.surfaces).toHaveLength(2);
    expect(collapses.map((item) => item.domain)).toEqual(["mintlify.com", "mintlify.com"]);
    expect(result.surfaces.map(surfaceDedupKey)).toEqual(["mcp|mintlify.com/mcp", "http|x.com/openapi"]);
    const httpSurface = result.surfaces[1] as { spec?: string; specAlternates?: string[] };
    expect(httpSurface.spec).toBe("https://x.com/openapi.json");
    expect(httpSurface.specAlternates).toEqual(["https://x.com/openapi.yaml"]);
    expect(result.surfaces[0]!.auth.status).toBe("required");
    expect(result.surfaces[0]!.docs).toBe("https://mintlify.com/docs/mcp");
    expect(result.surfaces[0]!.notes).toBe("Self-onboarding.");
    expect(result.credentials).toHaveLength(1);
    const entries = result.surfaces[0]!.auth.entries!;
    expect(entries[0]!.use[0]!.id).toBe("mint_oauth");
  });

  test("dedups locator-less surfaces by type and name", () => {
    const raw = {
      surfaces: [
        { type: "cli", name: "Acme CLI", auth: { status: "unknown" } },
        { type: "cli", name: "acme cli", auth: { status: "none", basis: { via: "discovered", evidence: ["https://example.com"] } } },
      ],
    };
    expect(dedupSurfaces(raw).surfaces).toHaveLength(1);
  });

  test("unions CLI package registries when duplicate CLI surfaces collapse", () => {
    const raw = {
      surfaces: [
        {
          type: "cli",
          name: "pscale CLI",
          command: "pscale",
          packages: [{ registryType: "homebrew", identifier: "planetscale/tap/pscale" }],
          auth: { status: "required" },
        },
        {
          type: "cli",
          name: "pscale CLI",
          command: "pscale",
          packages: [
            { registryType: "homebrew", identifier: "planetscale/tap/pscale" },
            { registryType: "github", identifier: "planetscale/cli", runtimeHint: "prebuilt binaries/releases" },
            { registryType: "scoop", identifier: "pscale" },
          ],
          auth: { status: "required" },
        },
      ],
    };

    const merged = dedupSurfaces(raw);
    expect(merged.surfaces).toHaveLength(1);
    expect(merged.surfaces[0]!.packages).toEqual([
      { registryType: "homebrew", identifier: "planetscale/tap/pscale" },
      { registryType: "github", identifier: "planetscale/cli", runtimeHint: "prebuilt binaries/releases" },
      { registryType: "scoop", identifier: "pscale" },
    ]);
  });
});
