import { describe, expect, test } from "bun:test";
import { aliasesOf, assertValidDomainAliases, canonicalDomain } from "./domain-aliases.ts";

describe("domain aliases", () => {
  test("canonicalizes known aliases case-insensitively", () => {
    expect(canonicalDomain(" SENTRY.DEV ")).toBe("sentry.io");
    expect(canonicalDomain("Vercel.SH")).toBe("vercel.com");
    expect(canonicalDomain("zeit.co")).toBe("vercel.com");
    expect(canonicalDomain("railway.app")).toBe("railway.com");
  });

  test("passes through unknown domains", () => {
    expect(canonicalDomain("example.com")).toBe("example.com");
    expect(canonicalDomain("sentrysoftware.com")).toBe("sentrysoftware.com");
  });

  test("lists aliases for a canonical domain", () => {
    expect(aliasesOf("sentry.io")).toEqual(["sentry.dev"]);
    expect(aliasesOf("SENTRY.DEV")).toEqual(["sentry.dev"]);
    expect(aliasesOf("example.com")).toEqual([]);
  });

  test("rejects alias chains and cycles", () => {
    expect(() => assertValidDomainAliases({ "a.example": "b.example", "b.example": "c.example" })).toThrow("chain/cycle");
    expect(() => assertValidDomainAliases({ "a.example": "b.example", "b.example": "a.example" })).toThrow("chain/cycle");
  });
});
