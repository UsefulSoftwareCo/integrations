import { describe, expect, test } from "bun:test";
import type { CatalogDomain } from "./discovered-catalog.ts";
import { probeRedirectCanonical, type FetchLike } from "./redirect-canonical.ts";

function response(url: string, status = 200, headers?: HeadersInit): Response {
  const res = new Response(null, { status, headers });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

function mockFetch(routes: Record<string, Response>): FetchLike {
  return async (input, init) => {
    const key = `${init?.redirect ?? "follow"} ${String(input)}`;
    const res = routes[key] ?? routes[String(input)];
    if (!res) throw new Error(`unexpected fetch ${key}`);
    return res;
  };
}

function catalogDomain(domain: string, surfaces: CatalogDomain["surfaces"]): CatalogDomain {
  return {
    domain,
    summary: `${domain} integration surfaces`,
    surfaces,
  };
}

function surface(name: string, url: string, spec?: string): CatalogDomain["surfaces"][number] {
  return {
    authStatus: "required",
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    type: "mcp",
    url,
    ...(spec ? { spec } : {}),
  };
}

describe("probeRedirectCanonical", () => {
  test("accepts a clean domain-wide apex redirect", async () => {
    const decision = await probeRedirectCanonical("old.dev", {
      fetchImpl: mockFetch({
        "follow https://old.dev/": response("https://new.com/"),
        "follow https://old.dev/robots.txt": response("https://new.com/robots.txt", 404),
      }),
      secondPath: "/robots.txt",
    });

    expect(decision.kind).toBe("alias");
    if (decision.kind !== "alias") throw new Error("expected alias");
    expect(decision.source).toBe("old.dev");
    expect(decision.target).toBe("new.com");
  });

  test("rejects a root-only redirect when a second path stays on the source", async () => {
    const decision = await probeRedirectCanonical("root-only.dev", {
      fetchImpl: mockFetch({
        "follow https://root-only.dev/": response("https://new.com/"),
        "follow https://root-only.dev/robots.txt": response("https://root-only.dev/robots.txt", 200),
      }),
      secondPath: "/robots.txt",
    });

    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("expected rejection");
    expect(decision.reason).toBe("root-second-target-mismatch");
  });

  test("rejects a subdomain source before probing cross-domain redirects", async () => {
    let calls = 0;
    const decision = await probeRedirectCanonical("mcp.example.dev", {
      fetchImpl: async (input, init) => {
        calls++;
        return mockFetch({
          "follow https://mcp.example.dev/": response("https://example.com/"),
          "follow https://mcp.example.dev/robots.txt": response("https://example.com/robots.txt", 404),
        })(input, init);
      },
      secondPath: "/robots.txt",
    });

    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("expected rejection");
    expect(decision.reason).toBe("subdomain-source");
    expect(calls).toBe(0);
  });

  test("rejects an apex source with a live surface URL on the apex", async () => {
    let calls = 0;
    const decision = await probeRedirectCanonical("old.dev", {
      catalogDomains: [
        catalogDomain("old.dev", [
          surface("Old MCP server", "https://old.dev/mcp"),
        ]),
      ],
      fetchImpl: async () => {
        calls++;
        throw new Error("fetch should not run after live source surface veto");
      },
    });

    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("expected rejection");
    expect(decision.reason).toBe("live-surfaces-on-source");
    expect(calls).toBe(0);
  });

  test("accepts an apex source whose surfaces live on a subdomain or target", async () => {
    const decision = await probeRedirectCanonical("pscale.dev", {
      catalogDomains: [
        catalogDomain("pscale.dev", [
          surface("PlanetScale MCP server", "https://mcp.pscale.dev/mcp/planetscale"),
          surface("PlanetScale API", "https://api.planetscale.com/v1", "https://planetscale.com/docs/openapi.yaml"),
        ]),
      ],
      fetchImpl: mockFetch({
        "follow https://pscale.dev/": response("https://planetscale.com/"),
        "follow https://pscale.dev/robots.txt": response("https://planetscale.com/robots.txt", 404),
      }),
      secondPath: "/robots.txt",
    });

    expect(decision.kind).toBe("alias");
    if (decision.kind !== "alias") throw new Error("expected alias");
    expect(decision.source).toBe("pscale.dev");
    expect(decision.target).toBe("planetscale.com");
  });

  test("rejects parked or aggregator targets", async () => {
    const decision = await probeRedirectCanonical("abandoned.dev", {
      fetchImpl: mockFetch({
        "follow https://abandoned.dev/": response("https://www.godaddy.com/forsale/abandoned.dev"),
      }),
    });

    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("expected rejection");
    expect(decision.reason).toBe("denylisted-target");
  });

  test("does not treat same-registrable apex/www redirects as aliases", async () => {
    const decision = await probeRedirectCanonical("example.dev", {
      fetchImpl: mockFetch({
        "follow https://example.dev/": response("https://www.example.dev/"),
      }),
    });

    expect(decision.kind).toBe("no_alias");
    if (decision.kind !== "no_alias") throw new Error("expected no_alias");
    expect(decision.reason).toBe("same-registrable");
  });
});
