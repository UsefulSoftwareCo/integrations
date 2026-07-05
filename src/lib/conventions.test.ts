import { describe, expect, test } from "bun:test";
import { PROBE_KEYS, buildConventionRows } from "./conventions.ts";

describe("buildConventionRows", () => {
  test("distinguishes found, missing, and unprobed convention states", () => {
    const rows = buildConventionRows(
      {
        found: [PROBE_KEYS.integrationsJson],
        probed: [PROBE_KEYS.integrationsJson, PROBE_KEYS.llmsTxt],
        integrationsJson: {
          url: "https://example.com/.well-known/integrations.json",
          result: { version: 3 },
        },
      },
      "example.com",
    );

    expect(rows.find((row) => row.key === PROBE_KEYS.integrationsJson)).toMatchObject({
      status: "found",
      detail: "https://example.com/.well-known/integrations.json",
      specHref: "/publishing/",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.llmsTxt)).toMatchObject({
      status: "missing",
      detail: "/llms.txt",
      specHref: "https://llmstxt.org",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.agentCard)).toMatchObject({
      status: "unprobed",
      detail: "—",
      detailTitle: "not probed yet",
      specHref: "https://a2a-protocol.org",
    });
  });

  test("keeps found convention details to discovered URLs", () => {
    const rows = buildConventionRows(
      {
        probed: [
          PROBE_KEYS.llmsTxt,
          PROBE_KEYS.apiCatalog,
          PROBE_KEYS.openapiSchema,
          PROBE_KEYS.oauthProtectedResource,
          PROBE_KEYS.agentSkills,
        ],
        llmsTxt: { url: "https://example.com/llms.txt", content: "# Docs" },
        apiCatalog: { rest: ["https://api.example.com"], openapi: ["https://example.com/openapi.json"] },
        apiSchema: { url: "https://example.com/openapi.json", format: "openapi", version: "3.1.0" },
        auth: {
          oauth: {
            protectedResourceUrl: "https://example.com/.well-known/oauth-protected-resource",
            authorizationServers: ["https://auth.example.com"],
          },
        },
        agentSkills: { count: 2, names: ["Search", "Write"] },
      },
      "example.com",
    );

    expect(rows.find((row) => row.key === PROBE_KEYS.llmsTxt)).toMatchObject({
      detail: "https://example.com/llms.txt",
      specHref: "https://llmstxt.org",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.apiCatalog)).toMatchObject({
      detail: "https://example.com/.well-known/api-catalog",
      specHref: "https://www.rfc-editor.org/rfc/rfc9727",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.openapiSchema)).toMatchObject({
      detail: "https://example.com/openapi.json",
      specHref: "https://spec.openapis.org/oas/latest.html",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.oauthProtectedResource)).toMatchObject({
      detail: "https://example.com/.well-known/oauth-protected-resource",
      specHref: "https://www.rfc-editor.org/rfc/rfc9728",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.agentSkills)).toMatchObject({
      detail: "https://example.com/.well-known/agent-skills/index.json",
      specHref: undefined,
    });
  });
});
