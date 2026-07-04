import { describe, expect, test } from "bun:test";
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
    const decision = await probeRedirectCanonical("docs.old.dev", {
      fetchImpl: mockFetch({
        "follow https://docs.old.dev/": response("https://new.com/"),
        "follow https://docs.old.dev/robots.txt": response("https://docs.old.dev/robots.txt", 200),
      }),
      secondPath: "/robots.txt",
    });

    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("expected rejection");
    expect(decision.reason).toBe("root-second-target-mismatch");
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

  test("does not treat same-registrable www/apex redirects as aliases", async () => {
    const decision = await probeRedirectCanonical("www.example.com", {
      fetchImpl: mockFetch({
        "follow https://www.example.com/": response("https://example.com/"),
      }),
    });

    expect(decision.kind).toBe("no_alias");
    if (decision.kind !== "no_alias") throw new Error("expected no_alias");
    expect(decision.reason).toBe("same-registrable");
  });
});
