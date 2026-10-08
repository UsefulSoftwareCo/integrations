import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistryAuth, resolveOpenapiAuth, slimSpec, summarizeSpecAuth } from "./openapi-auth.ts";
import { applyJsonPatch } from "./openapi-auth-cache.ts";

const oas = (extra: Record<string, unknown>) => ({
  openapi: "3.0.0",
  servers: [{ url: "https://api.example-vendor.com/v1" }],
  paths: {},
  ...extra,
});
const schemes = (s: Record<string, unknown>) => ({ components: { securitySchemes: s } });
const fromSpec = (doc: unknown, registry?: Parameters<typeof resolveOpenapiAuth>[0]["registry"]) =>
  resolveOpenapiAuth({ spec: summarizeSpecAuth(slimSpec(doc), "https://vendor.dev/openapi.json"), registry });

describe("spec analysis", () => {
  test("one bearer scheme in use", () => {
    expect(fromSpec(oas({ ...schemes({ bearer: { type: "http", scheme: "bearer" } }), security: [{ bearer: [] }] }))).toEqual({
      kind: "token",
      header: "Authorization: Bearer {token}",
      scheme: "bearer",
      source: "spec",
    });
  });

  test("apiKey in query and Swagger 2 basic", () => {
    expect(
      fromSpec(oas({ ...schemes({ k: { type: "apiKey", in: "query", name: "api_key" } }), security: [{ k: [] }] })),
    ).toEqual({ kind: "api_key", query: "api_key", scheme: "k", source: "spec" });
    expect(
      fromSpec({ swagger: "2.0", host: "api.vendor.io", securityDefinitions: { b: { type: "basic" } }, security: [{ b: [] }], paths: {} }),
    ).toEqual({ kind: "basic", header: "Authorization: Basic {username}:{password}", scheme: "b", source: "spec" });
  });

  test("an operation-level requirement counts as in use", () => {
    const doc = oas({
      ...schemes({ k: { type: "apiKey", in: "header", name: "X-Api-Key" } }),
      paths: { "/a": { get: { security: [{ k: [] }] } } },
    });
    expect(fromSpec(doc)).toMatchObject({ header: "X-Api-Key: {api_key}", scheme: "k" });
  });

  test("an unreferenced lone scheme gives the header without binding a scheme", () => {
    const auth = fromSpec(oas(schemes({ k: { type: "apiKey", in: "header", name: "X-Key" } })));
    expect(auth).toEqual({ kind: "api_key", header: "X-Key: {api_key}", source: "spec" });
  });

  test("oauth2 authorization code", () => {
    const doc = oas({
      ...schemes({
        o: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: "https://v.dev/authorize", tokenUrl: "https://v.dev/token", scopes: { a: "" } } } },
      }),
      security: [{ o: ["a"] }],
    });
    expect(fromSpec(doc)).toMatchObject({ kind: "oauth", scheme: "o", oauth: { authorizationUrl: "https://v.dev/authorize", tokenUrl: "https://v.dev/token" } });
  });

  test("an implicit-only twin of an auth-code scheme is not a second credential", () => {
    const doc = {
      swagger: "2.0",
      host: "www.googleapis.com",
      securityDefinitions: {
        Oauth2: { type: "oauth2", flow: "implicit", authorizationUrl: "https://accounts.google.com/o/oauth2/auth" },
        Oauth2c: { type: "oauth2", flow: "accessCode", authorizationUrl: "https://accounts.google.com/o/oauth2/auth", tokenUrl: "https://accounts.google.com/o/oauth2/token" },
      },
      security: [{ Oauth2: [], Oauth2c: [] }],
      paths: {},
    };
    expect(fromSpec(doc)).toMatchObject({ kind: "oauth", scheme: "Oauth2c" });
  });

  test("ambiguity is omitted, and positive evidence is needed for none", () => {
    const two = schemes({ a: { type: "apiKey", in: "header", name: "X-A" }, b: { type: "http", scheme: "bearer" } });
    expect(fromSpec(oas({ ...two, security: [{ a: [] }, { b: [] }] }))).toBeUndefined();
    expect(fromSpec(oas({ ...two, security: [{ a: [], b: [] }] }))).toBeUndefined();
    expect(fromSpec(oas({}))).toBeUndefined();
    expect(fromSpec(oas({ security: [] }))).toEqual({ kind: "none", source: "spec" });
  });

  test("a key that only works paired with a second key is not one credential", () => {
    // Datadog-style: every operation needs api key AND app key, except one.
    const doc = oas({
      ...schemes({ apiKeyAuth: { type: "apiKey", in: "header", name: "DD-API-KEY" }, appKeyAuth: { type: "apiKey", in: "header", name: "DD-APPLICATION-KEY" } }),
      security: [{ apiKeyAuth: [], appKeyAuth: [] }],
      paths: {
        ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/x${i}`, { get: { responses: {} } }])),
        "/validate": { get: { security: [{ apiKeyAuth: [] }] } },
      },
    });
    expect(summarizeSpecAuth(doc).combined).toBe(true);
    expect(fromSpec(doc)).toBeUndefined();
  });

  test("an API-wide token survives a few operations with their own scheme", () => {
    const doc = oas({
      ...schemes({ token: { type: "http", scheme: "bearer" }, uploadJwt: { type: "http", scheme: "bearer" } }),
      security: [{ token: [] }],
      paths: {
        ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/x${i}`, { get: { responses: {} } }])),
        "/upload": { post: { security: [{ uploadJwt: [] }] } },
      },
    });
    expect(fromSpec(doc)).toMatchObject({ kind: "token", scheme: "token" });
  });

  test("registry data picks one of several declared schemes", () => {
    const doc = oas({
      ...schemes({ a: { type: "apiKey", in: "header", name: "X-A" }, b: { type: "http", scheme: "bearer" } }),
      security: [{ a: [] }, { b: [] }],
    });
    expect(fromSpec(doc, { kind: "api_key", header: "X-A: {api_key}" })).toEqual({
      kind: "api_key",
      header: "X-A: {api_key}",
      scheme: "a",
      source: "registry",
    });
  });

  test("a per-tenant host or a needed connection setting is never one-click", () => {
    const one = { ...schemes({ b: { type: "http", scheme: "bearer" } }), security: [{ b: [] }] };
    expect(fromSpec(oas({ ...one, servers: [{ url: "https://{subdomain}.vendor.com", variables: { subdomain: { default: "acme" } } }] }))).toBeUndefined();
    expect(fromSpec(oas({ ...one, servers: [{ url: "https://{region}.vendor.com", variables: { region: { default: "us", enum: ["us", "eu"] } } }] }))).toBeDefined();
    expect(fromSpec(oas(one), { kind: "token", header: "Authorization: Bearer {token}", requires: ["subdomain"] })).toBeUndefined();
  });

  test("a relative server on a spec mirror has no derivable base URL", () => {
    const doc = { openapi: "3.0.0", paths: {}, ...schemes({ b: { type: "http", scheme: "bearer" } }), security: [{ b: [] }] };
    expect(summarizeSpecAuth(doc, "https://api.apis.guru/v2/specs/x/openapi.json").noServer).toBe(true);
    expect(summarizeSpecAuth(doc, "https://api.vendor.dev/openapi.json").noServer).toBeUndefined();
  });

  test("the slim document summarizes like the full one", () => {
    const doc = oas({
      ...schemes({ a: { type: "apiKey", in: "header", name: "Authorization", description: "Use `Bearer <key>`" } }),
      paths: { "/x": { get: { security: [{ a: [] }], responses: {} }, post: { security: [], responses: {} } } },
    });
    expect(summarizeSpecAuth(slimSpec(doc))).toEqual(summarizeSpecAuth(doc));
    expect(fromSpec(doc)).toMatchObject({ kind: "token", header: "Authorization: Bearer {token}", scheme: "a" });
  });
});

describe("curated priority", () => {
  test("curated values win and borrow the spec's scheme key", () => {
    const spec = summarizeSpecAuth(oas({ ...schemes({ bearerToken: { type: "http", scheme: "bearer" } }), security: [{ bearerToken: [] }] }));
    expect(resolveOpenapiAuth({ curated: { auth: "token", authHeader: "Authorization: Bearer {pat}" }, spec })).toEqual({
      kind: "token",
      header: "Authorization: Bearer {pat}",
      scheme: "bearerToken",
      source: "curated",
    });
  });

  test("a curated oauth kind takes the spec's OAuth endpoints", () => {
    const spec = summarizeSpecAuth(
      oas({
        ...schemes({
          o: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: "https://v.dev/a", tokenUrl: "https://v.dev/t", scopes: {} } } },
          k: { type: "apiKey", in: "header", name: "X-K" },
        }),
        security: [{ o: [] }, { k: [] }],
      }),
    );
    expect(resolveOpenapiAuth({ curated: { auth: "oauth" }, spec })).toMatchObject({
      kind: "oauth",
      scheme: "o",
      oauth: { authorizationUrl: "https://v.dev/a", tokenUrl: "https://v.dev/t" },
      source: "curated",
    });
  });
});

describe("registry data", () => {
  test("rejects malformed entries", () => {
    expect(() => parseRegistryAuth({ entries: { "x.com": { kind: "api_key" } } })).toThrow(/no header or query/);
    expect(() => parseRegistryAuth({ entries: { "x.com": { kind: "basic", header: "Authorization: Basic {key}" } } })).toThrow();
    expect(() => parseRegistryAuth({ entries: { "x.com": { kind: "oauth" } } })).toThrow(/oauth/);
  });

  test("the checked-in data is valid", () => {
    const json = JSON.parse(readFileSync(join(import.meta.dir, "../../registry-auth.json"), "utf8"));
    expect(parseRegistryAuth(json).size).toBeGreaterThan(0);
  });
});

test("applyJsonPatch removes and replaces", () => {
  const doc = { components: { securitySchemes: { A: {}, B: {} } }, security: [{ A: [] }] };
  expect(
    applyJsonPatch(doc, [
      { op: "remove", path: "/components/securitySchemes/A" },
      { op: "replace", path: "/security", value: [{ B: [] }] },
    ]),
  ).toEqual({ components: { securitySchemes: { B: {} } }, security: [{ B: [] }] });
  expect(doc.security).toEqual([{ A: [] }]);
});
