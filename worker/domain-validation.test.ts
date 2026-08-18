import { describe, expect, test } from "bun:test";
import { validateDiscoverableDomain } from "./domain-validation.ts";

describe("validateDiscoverableDomain", () => {
  test("rejects invalid, path, filename-style, and reserved domains", () => {
    for (const input of ["publishing.md", "llms-full.txt", "eva.ac%2Fhello", "example.com", "example.io", "localhost"]) {
      expect(validateDiscoverableDomain(input)).toEqual({ error: "not a public registrable domain" });
    }
  });

  test("accepts real domains and subdomain inputs", () => {
    expect(validateDiscoverableDomain("stripe.com")).toEqual({ domain: "stripe.com" });
    expect(validateDiscoverableDomain("music.youtube.com")).toEqual({ domain: "music.youtube.com" });
    expect(validateDiscoverableDomain("x.com")).toEqual({ domain: "x.com" });
  });
});
