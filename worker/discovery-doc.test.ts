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
});
