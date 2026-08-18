import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { discoverWithProgress, runDiscover, setChat, setWebBackend, type ChatFn } from "./operations.ts";

const originalFetch = globalThis.fetch;

function stubDetectFetch(): void {
  globalThis.fetch = (async () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })) as typeof fetch;
}

const web = {
  canSearch: true,
  search: async () => [],
  scrape: async () => "",
  sitemap: async () => [],
};

afterEach(() => {
  setChat(null);
  setWebBackend(web);
  globalThis.fetch = originalFetch;
});

describe("discovery operations", () => {
  test("runDiscover fails when the agent throws", async () => {
    stubDetectFetch();
    setWebBackend(web);
    setChat(async () => {
      throw new Error("model crashed");
    });

    await expect(Effect.runPromise(runDiscover("stripe.com"))).rejects.toThrow("model crashed");
  });

  test("discoverWithProgress fails when the agent throws", async () => {
    stubDetectFetch();
    setWebBackend(web);
    setChat(async () => {
      throw new Error("model crashed");
    });

    await expect(discoverWithProgress("stripe.com", () => {})).rejects.toThrow("model crashed");
  });

  test("runDiscover preserves a completed zero-surface result", async () => {
    stubDetectFetch();
    setWebBackend(web);
    const chat: ChatFn = async () => ({
      message: { role: "assistant", content: null },
      toolCalls: [
        {
          id: "finish-1",
          name: "finish",
          arguments: {
            summary: "No public developer integration surfaces were found.",
            description: "Stripe is a payments platform.",
          },
        },
      ],
    });
    setChat(chat);

    const result = await Effect.runPromise(runDiscover("empty-run-test.com"));

    expect(result.usedLlm).toBe(true);
    expect(result.surfaces).toEqual([]);
    expect(result.summary).toBe("No public developer integration surfaces were found.");
  });
});
