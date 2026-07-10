import { describe, expect, test } from "bun:test";
import { buildDomainDiscovery } from "./domain-discovery.ts";
import type { Integration } from "./types.ts";

describe("buildDomainDiscovery", () => {
  test("merges discovered CLI surfaces into the baseline domain discovery", () => {
    const records: Integration[] = [
      {
        id: "mcp/notion",
        kind: "mcp",
        slug: "notion",
        name: "Notion MCP",
        description: "",
        categories: [],
        feeds: ["openai"],
        mcp: { remoteUrl: "https://mcp.notion.com/mcp" },
        raw: {},
      },
      {
        id: "openapi/notion",
        kind: "openapi",
        slug: "notion-api",
        name: "Notion API",
        description: "",
        categories: [],
        feeds: ["override"],
        openapi: {
          provider: "notion.so",
          version: "1",
          specUrl: "https://developers.notion.com/openapi.json",
          docsUrl: "https://developers.notion.com/reference",
          openapiVer: "3.1.0",
        },
        raw: {},
      },
    ];

    const discovered = {
      domain: "notion.so",
      summary: "Notion exposes APIs, MCP, and a CLI.",
      surfaces: [
        {
          slug: "notion-cli",
          name: "Notion CLI",
          type: "cli" as const,
          command: "ntn",
          authStatus: "required" as const,
        },
      ],
    };

    const doc = buildDomainDiscovery("notion.so", records, discovered, null);

    expect(doc.surfaces.map((surface) => surface.type)).toEqual(["cli", "mcp", "http"]);
    expect(doc.surfaces.find((surface) => surface.type === "cli")?.command).toBe("ntn");
  });
});
