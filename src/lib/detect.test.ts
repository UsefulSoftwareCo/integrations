import { describe, expect, test } from "bun:test";
import { PROBE_KEYS } from "./conventions.ts";
import { detect, type FetchLike } from "./detect.ts";

function fetchWithLlmsTxt(body: string, init?: ResponseInit): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href === "https://example.com/llms.txt") return new Response(body, init);
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, urls };
}

describe("detect llms.txt", () => {
  test("carries llms.txt content through the detection result", async () => {
    const content = "# Example docs\n\n- [API](https://example.com/docs/api)";
    const { fetchImpl, urls } = fetchWithLlmsTxt(content, { status: 200, headers: { "content-type": "text/plain" } });

    const result = await detect("example.com", fetchImpl);

    expect(result.llmsTxt).toEqual({
      url: "https://example.com/llms.txt",
      content,
    });
    expect(result.found).toContain(PROBE_KEYS.llmsTxt);
    expect(urls.filter((url) => url === "https://example.com/llms.txt")).toHaveLength(1);
  });

  test("rejects an HTML response masquerading as llms.txt", async () => {
    const { fetchImpl } = fetchWithLlmsTxt(" \n<!doctype html><title>Not found</title>", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

    const result = await detect("example.com", fetchImpl);

    expect(result.llmsTxt).toBeUndefined();
    expect(result.found).not.toContain(PROBE_KEYS.llmsTxt);
  });

  test("treats an empty llms.txt response as absent", async () => {
    const { fetchImpl } = fetchWithLlmsTxt("", { status: 200 });

    const result = await detect("example.com", fetchImpl);

    expect(result.llmsTxt).toBeUndefined();
    expect(result.found).not.toContain(PROBE_KEYS.llmsTxt);
  });
});
