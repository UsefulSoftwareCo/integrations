import { describe, expect, test } from "bun:test";
import { analyzeStaleEntry, detectPotentiallyStaleApiGuruEntries, type ApiGuruSpecLite } from "./stale-apis-guru.ts";

type MockFetch = (url: string) => Promise<Response>;

function mockFetch(responses: Record<string, { status: number; body: string; contentType?: string }>): MockFetch {
  return async (url: string) => {
    const response = responses[url];
    if (!response) throw new Error(`unmocked URL: ${url}`);
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.contentType ?? "text/plain" },
    });
  };
}

function entry(provider: string, updated = "2020-01-01T00:00:00.000Z", swaggerUrl?: string, link?: string, service?: string): ApiGuruSpecLite {
  return {
    provider,
    service: service ?? null,
    updated,
    swaggerUrl,
    link,
  };
}

describe("stale API.guru detection", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00.000Z");
  test("flags old specs when declared spec endpoints stop returning payloads", async () => {
    const specs = [entry("getsandbox.com", "2024-01-01T00:00:00.000Z", "https://getsandbox.com/api.json")];
    const fetchImpl = mockFetch({
      "https://getsandbox.com/api.json": {
        status: 200,
        contentType: "text/html",
        body: "<html><title>parked</title></html>",
      },
    });

    const stale = await detectPotentiallyStaleApiGuruEntries(specs, fetchImpl, {
      staleAfterDays: 365,
      timeoutMs: 5000,
      parallelism: 1,
      nowMs,
    });

    expect(stale).toHaveLength(1);
    expect(stale[0]?.provider).toBe("getsandbox.com");
    expect(stale[0]?.reasons[0]).toContain("no accessible OpenAPI/Swagger payload");
  });

  test("does not flag recent specs even if endpoint is unavailable", async () => {
    const specs = [entry("fastapi.com", "2026-06-20T00:00:00.000Z", "https://fastapi.com/api.json")];
    const fetchImpl = mockFetch({
      "https://fastapi.com/api.json": {
        status: 500,
        contentType: "text/plain",
        body: "down",
      },
    });

    const stale = await detectPotentiallyStaleApiGuruEntries(specs, fetchImpl, {
      staleAfterDays: 365,
      timeoutMs: 5000,
      parallelism: 1,
      nowMs,
    });

    expect(stale).toHaveLength(0);
  });

  test("keeps old records with accessible OpenAPI markers", async () => {
    const specs = [entry("modernapi.com", "2024-01-01T00:00:00.000Z", "https://modernapi.com/openapi.json")];
    const fetchImpl = mockFetch({
      "https://modernapi.com/openapi.json": {
        status: 200,
        contentType: "application/json",
        body: '{"openapi":"3.0.3","info":{"title":"Modern","version":"1.0.0"}}',
      },
    });

    const stale = await detectPotentiallyStaleApiGuruEntries(specs, fetchImpl, {
      staleAfterDays: 365,
      timeoutMs: 5000,
      parallelism: 1,
      nowMs,
    });

    expect(stale).toHaveLength(0);
  });

  test("skips records without detectable spec endpoints", () => {
    const probes = [] as const;
    const spec = entry("nospec.com", "2024-01-01T00:00:00.000Z");
    const result = analyzeStaleEntry(spec, [...probes], 365, nowMs);
    expect(result.stale).toBe(false);
  });
});

