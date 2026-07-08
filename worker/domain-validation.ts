import { canonicalDomain } from "../src/lib/domain-aliases.ts";
import { isJunkDomain, registrableDomain } from "../src/lib/favicon.ts";

export interface ValidDomain {
  domain: string;
}

export function validateDiscoverableDomain(input: string): ValidDomain | { error: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input).trim().toLowerCase();
  } catch {
    return { error: "not a public registrable domain" };
  }
  if (!decoded || decoded.includes("/")) return { error: "not a public registrable domain" };
  if (decoded === "publishing.md") return { error: "not a public registrable domain" };

  const canonical = canonicalDomain(decoded);
  const registrable = registrableDomain(canonical);
  if (!registrable || isJunkDomain(canonical)) return { error: "not a public registrable domain" };
  return { domain: canonical };
}
