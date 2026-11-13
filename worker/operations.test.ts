import { describe, expect, test } from "bun:test";
import { preserveSlugs } from "./operations.ts";

const base = "https://api.acme.example/v1";

describe("preserveSlugs", () => {
  test("keeps distinct slugs for spec-bearing APIs that share a base url", () => {
    const prior = [
      { slug: "backend-api", type: "http", url: base, spec: "https://acme.example/specs/backend.yml" },
      { slug: "platform-api", type: "http", url: base, spec: "https://acme.example/specs/platform.yml" },
    ];
    const fresh = [
      { slug: "backend-api-renamed", type: "http", url: base, spec: "https://acme.example/specs/backend.yml" },
      { slug: "platform-api-renamed", type: "http", url: base, spec: "https://acme.example/specs/platform.yml" },
    ];

    preserveSlugs(fresh, prior);

    expect(fresh.map((s) => s.slug)).toEqual(["backend-api", "platform-api"]);
  });

  test("keeps the slug when an API gains a spec and its url is unambiguous", () => {
    const prior = [{ slug: "backend-api", type: "http", url: base }];
    const fresh = [{ slug: "backend-api-2", type: "http", url: base, spec: "https://acme.example/specs/backend.yml" }];

    preserveSlugs(fresh, prior);

    expect(fresh[0].slug).toBe("backend-api");
  });

  test("does not hand one prior slug to several APIs that share its url", () => {
    const prior = [{ slug: "backend-api", type: "http", url: base }];
    const fresh = [
      { slug: "backend-api", type: "http", url: base, spec: "https://acme.example/specs/backend.yml" },
      { slug: "platform-api", type: "http", url: base, spec: "https://acme.example/specs/platform.yml" },
    ];

    preserveSlugs(fresh, prior);

    expect(fresh.map((s) => s.slug)).toEqual(["backend-api", "platform-api"]);
  });

  test("still carries a renamed surface's slug by url", () => {
    const prior = [{ slug: "mcp-server", type: "mcp", url: "https://mcp.acme.example/mcp" }];
    const fresh = [{ slug: "acme-mcp", type: "mcp", url: "https://mcp.acme.example/mcp" }];

    preserveSlugs(fresh, prior);

    expect(fresh[0].slug).toBe("mcp-server");
  });
});
