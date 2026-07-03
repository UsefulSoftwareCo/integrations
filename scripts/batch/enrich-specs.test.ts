import { describe, expect, test } from "bun:test";
import { candidateSpecUrls, isOAuthPlumbingUrl } from "./enrich-specs.ts";

describe("enrich-specs", () => {
  test("generates deterministic OpenAPI candidates for a bare API host", () => {
    expect(candidateSpecUrls("https://api.openstatus.dev")).toEqual([
      "https://api.openstatus.dev/openapi.json",
      "https://api.openstatus.dev/openapi.yaml",
      "https://api.openstatus.dev/openapi",
      "https://api.openstatus.dev/swagger.json",
      "https://api.openstatus.dev/api/openapi.json",
      "https://api.openstatus.dev/v1/openapi.json",
      "https://api.openstatus.dev/v1/openapi",
      "https://api.openstatus.dev/api-docs",
      "https://api.openstatus.dev/api/schema/",
      "https://api.openstatus.dev/.well-known/openapi.json",
    ]);
  });

  test("adds v1-base probes when the surface URL starts with v1", () => {
    expect(candidateSpecUrls("https://api.example.com/v1/users").slice(10)).toEqual([
      "https://api.example.com/v1/openapi.yaml",
      "https://api.example.com/v1/swagger.json",
    ]);
  });

  test("matches OAuth plumbing surfaces without matching ordinary API routes", () => {
    expect(isOAuthPlumbingUrl("https://sentry.io/oauth/authorize/")).toBe(true);
    expect(isOAuthPlumbingUrl("https://sentry.io/oauth/token/")).toBe(true);
    expect(isOAuthPlumbingUrl("https://example.com/oauth2/device")).toBe(true);
    expect(isOAuthPlumbingUrl("https://example.com/api/authorize")).toBe(true);
    expect(isOAuthPlumbingUrl("https://example.com/api/organizations/authorize/list")).toBe(false);
    expect(isOAuthPlumbingUrl("https://example.com/api/tokenize")).toBe(false);
  });
});
