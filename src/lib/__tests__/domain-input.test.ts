import { describe, expect, test } from "bun:test";
import { domainFromUrlPath } from "../domain-input.ts";

describe("domain URL route input", () => {
  test("extracts hostnames from HTTP and HTTPS URLs", () => {
    expect(domainFromUrlPath("/https://codex-resets.com/")).toBe("codex-resets.com");
    expect(domainFromUrlPath("/http://codex-resets.com/")).toBe("codex-resets.com");
  });

  test("uses only the hostname from a full URL", () => {
    expect(domainFromUrlPath("/https://codex-resets.com/docs/page")).toBe("codex-resets.com");
  });

  test("does not interpret bare domains or malformed URLs as URL routes", () => {
    expect(domainFromUrlPath("/codex-resets.com/")).toBeNull();
    expect(domainFromUrlPath("/https:///")).toBeNull();
  });
});
