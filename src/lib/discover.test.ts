import { describe, expect, test } from "bun:test";
import { PROBE_KEYS } from "./conventions.ts";
import { discover, mergeDeclared, slackMcpAppManifestUrl, type ChatFn, type WebBackend } from "./discover.ts";
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

describe("mergeDeclared", () => {
  const declaredSource = "https://acme.example/.well-known/integrations.json";
  const declaredBasis = { via: "declared", source: declaredSource } as const;

  function resultWith(surfaces: object[]): Parameters<typeof mergeDeclared>[0] {
    return {
      version: 3,
      domain: "acme.example",
      summary: "",
      credentials: {},
      surfaces,
    } as Parameters<typeof mergeDeclared>[0];
  }

  function detectionWith(surfaces: object[]): DetectionResult {
    return {
      ...baseDetection(""),
      integrationsJson: {
        url: declaredSource,
        result: { version: 3, credentials: {}, surfaces },
      },
    } as DetectionResult;
  }

  test("merges a declared surface into its discovered twin when only one carries a spec", () => {
    const r = resultWith([
      {
        type: "http",
        slug: "backend-api",
        name: "Backend API",
        url: "https://api.acme.example/v1",
        basis: { via: "discovered", evidence: [] },
        auth: { status: "unknown" },
      },
    ]);
    mergeDeclared(
      r,
      detectionWith([
        {
          type: "http",
          slug: "backend-api",
          name: "Backend API",
          url: "https://api.acme.example/v1",
          spec: "https://acme.example/specs/backend.yml",
          basis: declaredBasis,
          auth: { status: "unknown" },
        },
      ]),
    );

    expect(r.surfaces).toHaveLength(1);
    expect(r.surfaces[0].slug).toBe("backend-api");
    expect(r.surfaces[0].spec).toBe("https://acme.example/specs/backend.yml");
    expect(r.surfaces[0].basis.via).toBe("declared");
  });

  test("falls back to type+name when locator urls are templated differently", () => {
    const r = resultWith([
      {
        type: "http",
        slug: "frontend-api",
        name: "Frontend API",
        url: "https://{domain}.accounts.example",
        basis: { via: "discovered", evidence: [] },
        auth: { status: "unknown" },
      },
    ]);
    mergeDeclared(
      r,
      detectionWith([
        {
          type: "http",
          slug: "frontend-api",
          name: "Frontend API",
          url: "https://{frontend_api}",
          spec: "https://acme.example/specs/frontend.yml",
          basis: declaredBasis,
          auth: { status: "unknown" },
        },
      ]),
    );

    expect(r.surfaces).toHaveLength(1);
    expect(r.surfaces[0].spec).toBe("https://acme.example/specs/frontend.yml");
  });

  test("still appends genuinely new declared surfaces", () => {
    const r = resultWith([
      {
        type: "http",
        slug: "backend-api",
        name: "Backend API",
        url: "https://api.acme.example/v1",
        basis: { via: "discovered", evidence: [] },
        auth: { status: "unknown" },
      },
    ]);
    mergeDeclared(
      r,
      detectionWith([
        {
          type: "http",
          slug: "platform-api",
          name: "Platform API",
          url: "https://api.acme.example/v1#platform",
          basis: declaredBasis,
          auth: { status: "unknown" },
        },
      ]),
    );

    expect(r.surfaces).toHaveLength(2);
    expect(r.surfaces.map((s) => s.slug)).toEqual(["backend-api", "platform-api"]);
  });

  test("does not merge distinct spec-bearing APIs that share a base url", () => {
    const r = resultWith([
      {
        type: "http",
        slug: "backend-api",
        name: "Backend API",
        url: "https://api.acme.example/v1",
        basis: { via: "discovered", evidence: [] },
        auth: { status: "unknown" },
      },
    ]);
    mergeDeclared(
      r,
      detectionWith([
        {
          type: "http",
          slug: "backend-api",
          name: "Backend API",
          url: "https://api.acme.example/v1",
          spec: "https://acme.example/specs/backend.yml",
          basis: declaredBasis,
          auth: { status: "unknown" },
        },
        {
          type: "http",
          slug: "platform-api",
          name: "Platform API",
          url: "https://api.acme.example/v1",
          spec: "https://acme.example/specs/platform.yml",
          basis: declaredBasis,
          auth: { status: "unknown" },
        },
      ]),
    );

    expect(r.surfaces.map((s) => s.slug)).toEqual(["backend-api", "platform-api"]);
    expect(r.surfaces[0].spec).toBe("https://acme.example/specs/backend.yml");
    expect(r.surfaces[1].spec).toBe("https://acme.example/specs/platform.yml");
  });
});

describe("MCP OAuth binding with multiple OAuth credentials", () => {
  const mcpUrl = "https://mcp.acme.example/mcp";
  const cliSession = {
    id: "cli_session",
    type: "oauth2",
    label: "Acme CLI session",
    setup: "Run `acme auth login` to authenticate the CLI through your browser.",
  };
  const mcpSession = {
    id: "mcp_session",
    type: "oauth2",
    label: "Acme MCP OAuth",
    setup: "Approve access in the browser.",
  };
  const discovered = { via: "discovered", evidence: ["https://docs.acme.example/cli"] };

  function serviceDetection(declaredSurfaces?: object[]): DetectionResult {
    return {
      domain: "acme.example",
      found: ["mcp"],
      probed: [],
      mcp: [{ url: mcpUrl, source: "probe", auth: "oauth2", authorizationServer: "https://auth.acme.example", dcr: true, cimd: true }],
      ...(declaredSurfaces && {
        integrationsJson: {
          url: "https://acme.example/.well-known/integrations.json",
          result: { version: 3, credentials: {}, surfaces: declaredSurfaces },
        },
      }),
      errors: [],
    } as DetectionResult;
  }

  async function discoverService(detect: DetectionResult, bindCliInModel: boolean) {
    const chat: ChatFn = async () => ({
      message: { role: "assistant", content: null },
      toolCalls: [
        { id: "cred-cli", name: "record_credential", arguments: cliSession },
        { id: "cred-mcp", name: "record_credential", arguments: mcpSession },
        {
          id: "surface-cli",
          name: "record_surface",
          arguments: {
            name: "Acme CLI",
            type: "cli",
            command: "acme",
            authStatus: bindCliInModel ? "required" : "unknown",
            ...(bindCliInModel && {
              auth: [{ use: [{ id: "cli_session", mechanics: { source: "cli", command: "acme auth login" } }], basis: discovered }],
            }),
            basis: discovered,
          },
        },
        {
          id: "surface-mcp",
          name: "record_surface",
          arguments: { name: "Acme MCP server", type: "mcp", url: mcpUrl, authStatus: "unknown", basis: discovered },
        },
        { id: "finish-1", name: "finish", arguments: { summary: "Acme.", description: "Auth." } },
      ],
    });
    const result = await discover(detect.domain, detect, chat, web);
    if (!result) throw new Error("discover returned null");
    return result;
  }

  function mcpAuthIds(result: NonNullable<Awaited<ReturnType<typeof discover>>>): string[] {
    const mcp = result.surfaces.find((s) => s.type === "mcp" && s.url === mcpUrl);
    return mcp?.auth.status === "required" ? mcp.auth.entries.flatMap((e) => e.use.map((u) => u.id)) : [];
  }

  test("binds the MCP surface to mcp_session and leaves the CLI's credential untouched", async () => {
    const result = await discoverService(serviceDetection(), true);

    expect(result.credentials.cli_session.label).toBe(cliSession.label);
    expect(result.credentials.cli_session.setup).toBe(cliSession.setup);
    expect(mcpAuthIds(result)).toEqual(["mcp_session"]);
    expect(result.credentials.mcp_session.setup).toContain("self-onboarding");
  });

  test("treats credentials bound only by the owner declaration as in use", async () => {
    const result = await discoverService(
      serviceDetection([
        {
          type: "cli",
          slug: "acme-cli",
          name: "Acme CLI",
          command: "acme",
          basis: { via: "declared", source: "https://acme.example/.well-known/integrations.json" },
          auth: {
            status: "required",
            entries: [
              {
                use: [{ id: "cli_session", mechanics: { source: "cli", command: "acme auth login" } }],
                basis: { via: "declared", source: "https://acme.example/.well-known/integrations.json" },
              },
            ],
          },
        },
      ]),
      false,
    );

    expect(result.credentials.cli_session.label).toBe(cliSession.label);
    expect(result.credentials.cli_session.setup).toBe(cliSession.setup);
    expect(mcpAuthIds(result)).toEqual(["mcp_session"]);
  });
});
