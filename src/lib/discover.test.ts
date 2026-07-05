import { describe, expect, test } from "bun:test";
import { PROBE_KEYS } from "./conventions.ts";
import { discover, type ChatFn, type WebBackend } from "./discover.ts";
import type { DetectionResult } from "./detect.ts";

const web: WebBackend = {
  canSearch: true,
  search: async () => [],
  scrape: async () => "",
  sitemap: async () => [],
};

function baseDetection(content: string): DetectionResult {
  return {
    domain: "example.com",
    found: [PROBE_KEYS.llmsTxt],
    probed: [PROBE_KEYS.llmsTxt],
    mcp: [],
    llmsTxt: {
      url: "https://example.com/llms.txt",
      content,
    },
    errors: [],
  };
}

async function initialUserPrompt(detect: DetectionResult): Promise<string> {
  let prompt = "";
  const chat: ChatFn = async (messages) => {
    prompt = String((messages[1] as { content?: unknown }).content ?? "");
    return {
      message: { role: "assistant", content: null },
      toolCalls: [
        {
          id: "finish-1",
          name: "finish",
          arguments: {
            summary: "No public developer integration surfaces were found.",
            description: "Example is a test service.",
          },
        },
      ],
    };
  };

  await discover("example.com", detect, chat, web);
  return prompt;
}

describe("discover llms.txt seed facts", () => {
  test("inlines llms.txt content as a documentation index", async () => {
    const prompt = await initialUserPrompt(baseDetection("# Example docs\n- https://example.com/docs/api"));

    expect(prompt).toContain("The domain publishes an llms.txt at https://example.com/llms.txt — a plain-text index of its documentation. Contents:");
    expect(prompt).toContain("<<<llms.txt\n# Example docs\n- https://example.com/docs/api\n>>>");
    expect(prompt).not.toContain("fallback");
  });

  test("truncates inlined llms.txt content at the cap on a line boundary", async () => {
    const firstLine = "a".repeat(39_990);
    const partialLine = "this-line-must-not-appear";
    const prompt = await initialUserPrompt(baseDetection(`${firstLine}\n${partialLine}\n`));

    expect(prompt).toContain(`${firstLine}\n[llms.txt truncated at 40000 chars — full file at https://example.com/llms.txt]`);
    expect(prompt).not.toContain(partialLine);
  });
});
