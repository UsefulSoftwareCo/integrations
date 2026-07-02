import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildSections, type DiscoverData } from "./surface-sections.ts";

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
      "Vercel CLI `vercel api`",
    ]);
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.href)).size).toBe(3);
    expect(entries.map((entry) => entry.meta)).not.toContain("7 tools");
    expect(entries.map((entry) => entry.name)).not.toContain("Vercel");
    expect(entries.map((entry) => entry.name)).not.toContain("Vercel API");
  });
});
