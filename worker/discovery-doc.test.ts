import { describe, expect, test } from "bun:test";
import { discoveryDoc } from "./discovery-doc.ts";
import type { Env } from "./env.ts";

const origin = "https://integrations.sh";

function envWith(options: { kv?: Record<string, string>; baseline?: unknown }): Env {
  return {
    DISCOVERY: {
      get: async (key: string) => options.kv?.[key] ?? null,
      put: async () => {},
    },
    ASSETS: {
      fetch: async () =>
        options.baseline
          ? new Response(JSON.stringify(options.baseline), { headers: { "content-type": "application/json" } })
          : new Response(null, { status: 404 }),
    },
  } as unknown as Env;
}

describe("discoveryDoc", () => {
  test("returns stored zero-surface docs", async () => {
    const discoveredAt = "2026-07-05T19:00:00.000Z";
    const result = { version: 3, domain: "empty.com", summary: "No surfaces found.", credentials: {}, surfaces: [] };
    const doc = await discoveryDoc(
      envWith({ kv: { "empty.com": JSON.stringify({ result, discoveredAt, model: "test" }) } }),
      origin,
      "empty.com",
    );

    expect(doc).toEqual({ ...result, discoveredAt });
  });

  test("returns baseline zero-surface docs", async () => {
    const baseline = { version: 3, domain: "baseline.com", summary: "", credentials: {}, surfaces: [] };
    const doc = await discoveryDoc(envWith({ baseline }), origin, "baseline.com");

    expect(doc).toEqual(baseline);
  });

  test("returns null for genuinely unknown domains", async () => {
    await expect(discoveryDoc(envWith({}), origin, "missing.com")).resolves.toBeNull();
  });

  const storedDoc = (domain: string, surfaces: unknown[]) => ({
    result: { version: 3, domain, summary: "", credentials: {}, surfaces },
    discoveredAt: "2026-07-05T19:00:00.000Z",
    model: "test",
  });

  test("backfills a stored surface's missing spec from a lone baseline candidate", async () => {
    const doc = await discoveryDoc(
      envWith({
        kv: {
          "notionish.com": JSON.stringify(
            storedDoc("notionish.com", [
              { type: "http", url: "https://api.notionish.com", slug: "rest-api" },
              { type: "mcp", url: "https://mcp.notionish.com/mcp", slug: "mcp" },
            ]),
          ),
        },
        baseline: {
          version: 3,
          domain: "notionish.com",
          surfaces: [{ type: "http", spec: "https://spec.example/openapi.json", url: "https://api.notionish.com" }],
        },
      }),
      origin,
      "notionish.com",
    );

    expect(doc?.surfaces).toHaveLength(2);
    expect(doc?.surfaces?.[0]).toMatchObject({ slug: "rest-api", spec: "https://spec.example/openapi.json" });
  });

  test("appends baseline spec surfaces when the stored type has none and the match is ambiguous", async () => {
    const doc = await discoveryDoc(
      envWith({
        kv: {
          "datadogish.com": JSON.stringify(
            storedDoc("datadogish.com", [{ type: "http", url: "https://api.datadogish.com/api/", slug: "http-api" }]),
          ),
        },
        baseline: {
          version: 3,
          domain: "datadogish.com",
          surfaces: [
            { type: "http", spec: "https://spec.example/v2.yaml", slug: "api-v2" },
            { type: "http", spec: "https://spec.example/v1.yaml", slug: "api-v1" },
          ],
        },
      }),
      origin,
      "datadogish.com",
    );

    expect(doc?.surfaces).toHaveLength(3);
    expect(doc?.surfaces?.map((s: { slug?: string }) => s.slug)).toEqual(["http-api", "api-v2", "api-v1"]);
  });

  test("leaves a type alone when a stored surface already carries its locator", async () => {
    const stored = [{ type: "http", spec: "https://stored.example/spec.json", slug: "kept" }];
    const doc = await discoveryDoc(
      envWith({
        kv: { "twilioish.com": JSON.stringify(storedDoc("twilioish.com", stored)) },
        baseline: {
          version: 3,
          domain: "twilioish.com",
          surfaces: [
            { type: "http", spec: "https://other.example/a.json", slug: "a" },
            { type: "http", spec: "https://other.example/b.json", slug: "b" },
          ],
        },
      }),
      origin,
      "twilioish.com",
    );

    expect(doc?.surfaces).toHaveLength(1);
    expect(doc?.surfaces?.[0]).toMatchObject({ slug: "kept", spec: "https://stored.example/spec.json" });
  });
});
