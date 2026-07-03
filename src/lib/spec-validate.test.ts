import { describe, expect, test } from "bun:test";
import { validateSpecUrl } from "./spec-validate.ts";

function fetchResponse(body: string, init: ResponseInit = {}): typeof fetch {
  return async () => new Response(body, init);
}

describe("validateSpecUrl", () => {
  test("accepts OpenAPI JSON", async () => {
    const result = await validateSpecUrl("https://example.com/openapi.json", "http", fetchResponse(JSON.stringify({ openapi: "3.1.0", paths: {} }), { headers: { "content-type": "application/json" } }));
    expect(result).toEqual({ ok: true, kind: "openapi-json" });
  });

  test("accepts OpenAPI YAML", async () => {
    const result = await validateSpecUrl("https://example.com/openapi.yaml", "http", fetchResponse("openapi: 3.1.0\npaths: {}\n", { headers: { "content-type": "application/yaml" } }));
    expect(result).toEqual({ ok: true, kind: "openapi-yaml" });
  });

  test("accepts Swagger 2.0 JSON", async () => {
    const result = await validateSpecUrl("https://example.com/swagger.json", "http", fetchResponse(JSON.stringify({ swagger: "2.0", paths: {} }), { headers: { "content-type": "application/json" } }));
    expect(result).toEqual({ ok: true, kind: "openapi-json" });
  });

  test("rejects an HTML docs portal", async () => {
    const result = await validateSpecUrl("https://example.com/developers/web/api", "http", fetchResponse("<!doctype html><html><body>API docs</body></html>", { headers: { "content-type": "text/html" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("docs portal");
  });

  test("rejects a Postman collection", async () => {
    const body = JSON.stringify({ info: { _postman_id: "abc", name: "API" }, item: [] });
    const result = await validateSpecUrl("https://example.com/collection.json", "http", fetchResponse(body, { headers: { "content-type": "application/json" } }));
    expect(result).toEqual({ ok: false, reason: "that is a Postman collection, not an OpenAPI spec" });
  });

  test("rejects AsyncAPI for HTTP surfaces", async () => {
    const result = await validateSpecUrl("https://example.com/asyncapi.json", "http", fetchResponse(JSON.stringify({ asyncapi: "3.0.0", channels: {} }), { headers: { "content-type": "application/json" } }));
    expect(result).toEqual({ ok: false, reason: "that is an AsyncAPI document; only OpenAPI is accepted for http surfaces" });
  });

  test("rejects OAuth endpoints by path", async () => {
    let called = false;
    const result = await validateSpecUrl("https://example.com/oauth/authorize", "http", async () => {
      called = true;
      return new Response("{}");
    });
    expect(result).toEqual({ ok: false, reason: "that is an OAuth endpoint, not a spec" });
    expect(called).toBe(false);
  });

  test("accepts GraphQL SDL", async () => {
    const result = await validateSpecUrl("https://example.com/schema.graphql", "graphql", fetchResponse("type Query {\n  viewer: User\n}\ninterface User { id: ID! }\n", { headers: { "content-type": "text/plain" } }));
    expect(result).toEqual({ ok: true, kind: "graphql-sdl" });
  });

  test("accepts GraphQL introspection literal", async () => {
    const result = await validateSpecUrl("introspection", "graphql", async () => {
      throw new Error("should not fetch");
    });
    expect(result).toEqual({ ok: true, kind: "introspection" });
  });

  test("rejects 404 responses", async () => {
    const result = await validateSpecUrl("https://example.com/openapi.json", "http", fetchResponse("not found", { status: 404 }));
    expect(result).toEqual({ ok: false, reason: "the URL did not return a document (HTTP 404)" });
  });

  test("rejects timeout or network errors", async () => {
    const result = await validateSpecUrl("https://example.com/openapi.json", "http", async () => {
      throw new Error("network");
    });
    expect(result).toEqual({ ok: false, reason: "the URL could not be fetched or timed out" });
  });

  test("accepts auth-gated spec endpoints (401)", async () => {
    const result = await validateSpecUrl("https://example.com/openapi.json", "http", fetchResponse("unauthorized", { status: 401 }));
    expect(result).toEqual({ ok: true, kind: "auth-gated" });
  });

  test("accepts auth-challenged endpoints (www-authenticate)", async () => {
    const result = await validateSpecUrl("https://example.com/graphql", "graphql", fetchResponse("denied", { status: 403, headers: { "www-authenticate": "Bearer" } }));
    expect(result).toEqual({ ok: true, kind: "auth-gated" });
  });

  test("accepts graphql endpoints that reject GET (405)", async () => {
    const result = await validateSpecUrl("https://example.com/graphql", "graphql", fetchResponse("method not allowed", { status: 405 }));
    expect(result).toEqual({ ok: true, kind: "auth-gated" });
  });

  test("still rejects 405 for http surfaces", async () => {
    const result = await validateSpecUrl("https://example.com/openapi.json", "http", fetchResponse("method not allowed", { status: 405 }));
    expect(result).toEqual({ ok: false, reason: "the URL did not return a document (HTTP 405)" });
  });
});
