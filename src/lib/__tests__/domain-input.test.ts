import { describe, expect, test } from "bun:test";
import { domainFromUrlPath } from "../domain-input.ts";

describe("domain URL route input", () => {
  test("extracts hostnames from HTTP and HTTPS URLs", () => {
    expect(domainFromUrlPath("/https://example.com/")).toBe("example.com");
    expect(domainFromUrlPath("/http://example.com/")).toBe("example.com");
  });

  test("uses only the hostname from a full URL", () => {
    expect(domainFromUrlPath("/https://example.com/docs/page")).toBe("example.com");
  });

  test("does not interpret bare domains or malformed URLs as URL routes", () => {
    expect(domainFromUrlPath("/example.com/")).toBeNull();
    expect(domainFromUrlPath("/https:///")).toBeNull();
  });
});
