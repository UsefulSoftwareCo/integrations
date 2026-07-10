import { describe, expect, test } from "bun:test";
import { mergeDomainSurfaceTypes } from "./domain-surface-types.ts";

describe("mergeDomainSurfaceTypes", () => {
  test("includes CLI for Notion when any underlying source exposes it", () => {
    expect(
      mergeDomainSurfaceTypes({
        curated: ["mcp", "openapi"],
        discovered: ["http", "mcp"],
        catalog: ["mcp", "openapi", "cli"],
      }),
    ).toEqual(["mcp", "openapi", "cli"]);
  });

  test("deduplicates repeated surface types while preserving project order", () => {
    expect(
      mergeDomainSurfaceTypes({
        curated: ["graphql", "mcp"],
        discovered: ["http", "graphql", "cli"],
        catalog: ["cli", "mcp", "openapi"],
      }),
    ).toEqual(["mcp", "openapi", "graphql", "cli"]);
  });

  test("keeps curated-only surfaces visible", () => {
    expect(mergeDomainSurfaceTypes({ curated: ["graphql"] })).toEqual(["graphql"]);
  });

  test("keeps raw-catalog-only surfaces visible", () => {
    expect(mergeDomainSurfaceTypes({ catalog: ["cli"] })).toEqual(["cli"]);
  });

  test("handles domains with no surfaces safely", () => {
    expect(mergeDomainSurfaceTypes({})).toEqual([]);
  });
});
