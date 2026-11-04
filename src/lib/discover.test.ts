import { describe, expect, test } from "bun:test";
import { PROBE_KEYS } from "./conventions.ts";
import { discover, slackMcpAppManifestUrl, type ChatFn, type WebBackend } from "./discover.ts";
import type { DetectionResult } from "./detect.ts";

const web: WebBackend = {
  canSearch: true,
  search: async () => [],
  scrape: async () => "",
  sitemap: async () => [],
};

function baseDetection(content: string): DetectionResult {
  return {
    domain: "example.com",
    found: [PROBE_KEYS.llmsTxt],
    probed: [PROBE_KEYS.llmsTxt],
    mcp: [],
    llmsTxt: {
      url: "https://example.com/llms.txt",
      content,
    },
    errors: [],
  };
}

async function initialUserPrompt(detect: DetectionResult): Promise<string> {
  let prompt = "";
  const chat: ChatFn = async (messages) => {
    prompt = String((messages[1] as { content?: unknown }).content ?? "");
    return {
      message: { role: "assistant", content: null },
      toolCalls: [
        {
          id: "finish-1",
          name: "finish",
          arguments: {
            summary: "No public developer integration surfaces were found.",
            description: "Example is a test service.",
          },
        },
      ],
    };
  };

  await discover("example.com", detect, chat, web);
  return prompt;
}

function mcpDetection(overrides: Partial<DetectionResult["mcp"][number]>): DetectionResult {
  return {
    domain: "slack.com",
    found: ["mcp", "auth"],
    probed: [],
    mcp: [
      {
        url: "https://mcp.slack.com/mcp",
        source: "probe",
        auth: "oauth2",
        authorizationServer: "https://slack.com",
        ...overrides,
      },
    ],
    errors: [],
  };
}

async function discoverMcp(detect: DetectionResult): Promise<NonNullable<Awaited<ReturnType<typeof discover>>>> {
  const chat: ChatFn = async () => ({
    message: { role: "assistant", content: null },
    toolCalls: [
      {
        id: "cred-1",
        name: "record_credential",
        arguments: {
          id: "oauth",
          type: "oauth2",
          label: "OAuth 2.0",
          setup: "## OAuth 2.0 — self-onboarding\nPoint your MCP client at the server URL; the client registers automatically.",
        },
      },
      {
        id: "surface-1",
        name: "record_surface",
        arguments: {
          name: "Slack MCP server",
          type: "mcp",
          url: detect.mcp[0]?.url ?? "https://mcp.slack.com/mcp",
          authStatus: "required",
          auth: [
            {
              use: [{ id: "oauth", mechanics: { source: "well-known" } }],
              basis: { via: "discovered", evidence: ["https://docs.example.com/mcp"] },
            },
          ],
          basis: { via: "discovered", evidence: ["https://docs.example.com/mcp"] },
        },
      },
      {
        id: "finish-1",
        name: "finish",
        arguments: {
          summary: "Provides an MCP server.",
          description: "Example service.",
        },
      },
    ],
  });
  const result = await discover(detect.domain, detect, chat, web);
  if (!result) throw new Error("discover returned null");
  return result;
}

function setupFrom(result: NonNullable<Awaited<ReturnType<typeof discover>>>): string {
  return result.credentials.oauth?.setup ?? "";
}

function decodeSlackManifestFrom(url: string): any {
  const encoded = new URL(url).searchParams.get("manifest_json");
  if (!encoded) throw new Error("missing manifest_json");
  return JSON.parse(encoded);
}

describe("discover llms.txt seed facts", () => {
  test("inlines llms.txt content as a documentation index", async () => {
    const prompt = await initialUserPrompt(baseDetection("# Example docs\n- https://example.com/docs/api"));

    expect(prompt).toContain("The domain publishes an llms.txt at https://example.com/llms.txt — a plain-text index of its documentation. Contents:");
    expect(prompt).toContain("<<<llms.txt\n# Example docs\n- https://example.com/docs/api\n>>>");
    expect(prompt).not.toContain("fallback");
  });

  test("truncates inlined llms.txt content at the cap on a line boundary", async () => {
    const firstLine = "a".repeat(39_990);
    const partialLine = "this-line-must-not-appear";
    const prompt = await initialUserPrompt(baseDetection(`${firstLine}\n${partialLine}\n`));

    expect(prompt).toContain(`${firstLine}\n[llms.txt truncated at 40000 chars — full file at https://example.com/llms.txt]`);
    expect(prompt).not.toContain(partialLine);
  });
});

describe("discover MCP onboarding overrides", () => {
  test("rewrites Slack no-DCR MCP setup to manual registration with the manifest deep link", async () => {
    const result = await discoverMcp(mcpDetection({ authorizationServerMetadataFetched: true, dcr: false, cimd: false }));
    const setup = setupFrom(result);

    expect(setup).toContain("pre-registered app required");
    expect(setup).toContain("api.slack.com/apps?new_app=1");
    expect(setup).toContain("is_mcp_enabled");
  });

  test("generates a Slack manifest link with MCP enabled, scopes, and no callback-only fields", () => {
    const manifest = decodeSlackManifestFrom(slackMcpAppManifestUrl());

    expect(manifest.settings.is_mcp_enabled).toBe(true);
    expect(manifest.oauth_config.scopes.user).toHaveLength(26);
    expect(manifest.oauth_config.scopes.user).toContain("users:read.email");
    expect(manifest.oauth_config).not.toHaveProperty("redirect_urls");
    expect(manifest.settings).not.toHaveProperty("agent_view");
  });

  test("keeps DCR-capable MCP servers self-onboarding", async () => {
    const result = await discoverMcp(mcpDetection({ authorizationServerMetadataFetched: true, dcr: true, cimd: false }));
    const setup = setupFrom(result);

    expect(setup).toContain("self-onboarding");
    expect(setup).toContain("Dynamic Client Registration");
    expect(setup).not.toContain("pre-registered app required");
  });

  test("does not rewrite to manual when authorization server metadata was not fetched", async () => {
    const result = await discoverMcp(mcpDetection({ authorizationServerMetadataFetched: false, dcr: false, cimd: false }));
    const setup = setupFrom(result);

    expect(setup).toContain("client registers automatically");
    expect(setup).not.toContain("pre-registered app required");
  });

  test("uses generic manual setup for non-Slack no-DCR hosts", async () => {
    const result = await discoverMcp({
      ...mcpDetection({ url: "https://mcp.example.com/mcp", authorizationServer: "https://example.com", authorizationServerMetadataFetched: true, dcr: false, cimd: false }),
      domain: "example.com",
    });
    const setup = setupFrom(result);

    expect(setup).toContain("pre-registered app required");
    expect(setup).not.toContain("Slack MCP server access");
    expect(setup).not.toContain("api.slack.com/apps?new_app=1");
  });
});

describe("discover owner declaration merge", () => {
  const declaredSource = "https://example.com/.well-known/integrations.json";

  function httpDiscovery(recorded: Record<string, unknown>): ChatFn {
    return async () => ({
      message: { role: "assistant", content: null },
      toolCalls: [
        {
          id: "cred-1",
          name: "record_credential",
          arguments: { id: "api_key", type: "api_key", label: "API key", setup: "Create a key in the dashboard." },
        },
        {
          id: "surface-1",
          name: "record_surface",
          arguments: {
            name: "Example API",
            type: "http",
            authStatus: "required",
            auth: [{ use: [{ id: "api_key", mechanics: { source: "http", in: "header", headerName: "Authorization", scheme: "Bearer" } }], basis: { via: "discovered", evidence: ["https://example.com/docs/api"] } }],
            basis: { via: "discovered", evidence: ["https://example.com/docs/api"] },
            ...recorded,
          },
        },
        { id: "finish-1", name: "finish", arguments: { summary: "Provides an HTTP API.", description: "Example service." } },
      ],
    });
  }

  function declaredDetection(declaredSurface: Record<string, unknown>): DetectionResult {
    return {
      domain: "example.com",
      found: [PROBE_KEYS.integrationsJson],
      probed: [PROBE_KEYS.integrationsJson],
      mcp: [],
      errors: [],
      integrationsJson: {
        url: declaredSource,
        result: {
          version: 3,
          credentials: { api_key: { type: "api_key", label: "API key", setup: "Create a key in the dashboard." } },
          surfaces: [
            {
              slug: "api",
              name: "Example API",
              type: "http",
              basis: { via: "declared", source: declaredSource },
              auth: { status: "required", entries: [{ use: [{ id: "api_key", mechanics: { source: "http", in: "header", headerName: "Authorization", scheme: "Bearer" } }], basis: { via: "declared", source: declaredSource } }] },
              ...declaredSurface,
            },
          ],
        },
      } as DetectionResult["integrationsJson"],
    };
  }

  test("folds a declared surface with a spec into the discovered row that only knows the base URL", async () => {
    const chat = httpDiscovery({ url: "https://api.example.com/v1" });
    const result = await discover("example.com", declaredDetection({ url: "https://api.example.com/v1", spec: "https://api.example.com/v1/openapi.json" }), chat, web);
    if (!result) throw new Error("discover returned null");

    const http = result.surfaces.filter((s) => s.type === "http");
    expect(http).toHaveLength(1);
    expect(http[0]?.url).toBe("https://api.example.com/v1");
    expect(http[0]?.spec).toBe("https://api.example.com/v1/openapi.json");
    expect(http[0]?.basis.via).toBe("declared");
  });

  test("folds a declared base-URL-only surface into a discovered row that knows the spec", async () => {
    // A graphql "introspection" spec is a literal, not a URL, so record_surface
    // keeps it without the network validation an OpenAPI URL would trigger.
    const chat = httpDiscovery({ name: "Example GraphQL", type: "graphql", url: "https://api.example.com/graphql", spec: "introspection" });
    const result = await discover("example.com", declaredDetection({ name: "Example GraphQL", type: "graphql", url: "https://api.example.com/graphql" }), chat, web);
    if (!result) throw new Error("discover returned null");

    const graphql = result.surfaces.filter((s) => s.type === "graphql");
    expect(graphql).toHaveLength(1);
    expect(graphql[0]?.spec).toBe("introspection");
    expect(graphql[0]?.basis.via).toBe("declared");
  });

  test("still adds a declared surface for a different base URL", async () => {
    const chat = httpDiscovery({ url: "https://api.example.com/v1" });
    const result = await discover("example.com", declaredDetection({ name: "Ingest API", url: "https://ingest.example.com", slug: "ingest-api" }), chat, web);
    if (!result) throw new Error("discover returned null");

    expect(result.surfaces.filter((s) => s.type === "http")).toHaveLength(2);
  });
});
