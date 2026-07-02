import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DISCOVERY_STALE_MS, buildSections, discoveryFreshness, type DiscoverData } from "./surface-sections.ts";

function fixture(name: string): DiscoverData {
  const raw = readFileSync(new URL(`../../scripts/batch/results-full/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw).result as DiscoverData;
}

describe("buildSections", () => {
  test("renders only discovery surfaces for a KV-rich domain", () => {
    const sections = buildSections(fixture("vercel.com"), "vercel.com");
    const entries = sections.flatMap((section) => section.entries);

    expect(sections.map((section) => [section.kind, section.entries.length])).toEqual([
      ["mcp", 1],
      ["openapi", 1],
      ["cli", 1],
    ]);
    expect(entries.map((entry) => entry.name)).toEqual([
      "Vercel MCP server",
      "Vercel REST API",
      "Vercel CLI",
    ]);
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.href)).size).toBe(3);
    expect(entries.map((entry) => entry.meta)).not.toContain("7 tools");
    expect(entries.map((entry) => entry.name)).not.toContain("Vercel");
    expect(entries.map((entry) => entry.name)).not.toContain("Vercel API");
  });
});

describe("discoveryFreshness", () => {
  const now = Date.parse("2026-07-02T20:00:00.000Z");

  test("keeps fresh discovery informational", () => {
    const freshness = discoveryFreshness("2026-07-02T17:00:00.000Z", true, now);

    expect(freshness).toMatchObject({
      label: "3h ago",
      title: "2026-07-02T17:00:00.000Z",
      known: true,
      stale: false,
      shouldRegenerate: false,
    });
  });

  test("marks discovery older than twelve hours for regeneration", () => {
    const freshness = discoveryFreshness(new Date(now - DISCOVERY_STALE_MS - 1).toISOString(), true, now);

    expect(freshness.stale).toBe(true);
    expect(freshness.shouldRegenerate).toBe(true);
  });

  test("treats surfaced baselines with no timestamp as unknown age", () => {
    expect(discoveryFreshness(undefined, true, now)).toMatchObject({
      label: "unknown age",
      known: false,
      stale: true,
      shouldRegenerate: true,
    });
    expect(discoveryFreshness(undefined, false, now).shouldRegenerate).toBe(false);
  });
});
