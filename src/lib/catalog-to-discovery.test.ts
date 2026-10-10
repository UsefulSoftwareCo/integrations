import { describe, expect, test } from "bun:test";
import { catalogDiscovery, recordToSurface } from "./catalog-to-discovery.ts";
import type { Integration } from "./types.ts";

const cli = (cliFields: Integration["cli"]): Integration => ({
  id: "curated/github-com-cli",
  kind: "cli",
  slug: "github-com-cli",
  name: "GitHub",
  description: "",
  categories: [],
  feeds: ["curated"],
  cli: cliFields,
  raw: {},
});

describe("recordToSurface", () => {
  test("a curated CLI publishes its real command, not its record slug", () => {
    const surface = recordToSurface(cli({ install: "brew install gh", command: "gh", domain: "github.com" }));
    expect(surface?.command).toBe("gh");
  });

  test("a feed CLI without a command keeps using its slug", () => {
    const surface = recordToSurface(cli({ install: "brew install gh", domain: "github.com" }));
    expect(surface?.command).toBe("github-com-cli");
  });
});

const mcp = (mcpFields: Integration["mcp"]): Integration => ({
  id: "curated/t3-codes-mcp",
  kind: "mcp",
  slug: "t3-codes",
  name: "T3 Code",
  description: "",
  categories: [],
  feeds: ["curated"],
  mcp: mcpFields,
  raw: {},
});

describe("catalogDiscovery", () => {
  test("a curated OAuth sign-in publishes its credential and binds it through well-known metadata", () => {
    const oauthCredential = { type: "oauth2" as const, label: "T3 Code sign-in", setup: "Enter a pairing code." };
    const doc = catalogDiscovery("t3.codes", [
      mcp({ remoteUrl: "https://{environment_address}/mcp", variables: [{ name: "environment_address" }], oauthCredential }),
    ]);
    expect(doc.credentials).toEqual({ "t3-codes-oauth": oauthCredential });
    expect(doc.surfaces[0]?.auth).toEqual({
      status: "required",
      entries: [{ use: [{ id: "t3-codes-oauth", mechanics: { source: "well-known" } }], basis: { via: "detected", signal: "registry" } }],
    });
  });

  test("an MCP record without a documented sign-in stays unknown", () => {
    const doc = catalogDiscovery("example.com", [mcp({ remoteUrl: "https://mcp.example.com/mcp" })]);
    expect(doc.credentials).toEqual({});
    expect(doc.surfaces[0]?.auth).toEqual({ status: "unknown" });
  });
});
