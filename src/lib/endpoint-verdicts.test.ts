import { describe, expect, test } from "bun:test";
import { applyEndpointVerdicts, isUnusableEndpoint } from "./endpoint-verdicts.ts";

describe("isUnusableEndpoint", () => {
  test("rejects a placeholder no variable declares", () => {
    expect(isUnusableEndpoint("https://{project_ref}.example.com/mcp")).toBe(true);
    expect(isUnusableEndpoint("https://{project_ref}.example.com/mcp", [{ name: "region" }])).toBe(true);
  });

  test("accepts a placeholder the surface declares as a variable", () => {
    expect(isUnusableEndpoint("https://{environment_address}/mcp", [{ name: "environment_address" }])).toBe(false);
  });

  test("still rejects loopback hosts", () => {
    expect(isUnusableEndpoint("http://localhost:3773/mcp")).toBe(true);
  });
});

describe("applyEndpointVerdicts", () => {
  test("keeps a self-hosted MCP surface whose URL is a declared template", () => {
    const auth = { status: "unknown" } as const;
    const surfaces = [
      { type: "mcp", url: "https://{environment_address}/mcp", variables: [{ name: "environment_address" }], auth },
      { type: "mcp", url: "https://{environment_address}/mcp", auth },
    ];
    expect(applyEndpointVerdicts(surfaces)).toEqual([surfaces[0]]);
  });
});
