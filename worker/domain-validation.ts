import { canonicalDomain } from "../src/lib/domain-aliases.ts";
import { isJunkDomain, registrableDomain } from "../src/lib/favicon.ts";

export interface ValidDomain {
  domain: string;
}

// The site's own root-level file pages whose names parse as valid domains
// (.md is Moldova's TLD). A crawler hitting /publishing.md lands here as a
// "domain" — these are paths, not services.
const SITE_FILE_PATHS = new Set(["publishing.md", "skill.md", "claude.md", "agents.md", "readme.md"]);

export function validateDiscoverableDomain(input: string): ValidDomain | { error: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input).trim().toLowerCase();
  } catch {
    return { error: "not a public registrable domain" };
  }
  if (!decoded || decoded.includes("/")) return { error: "not a public registrable domain" };
  if (SITE_FILE_PATHS.has(decoded)) return { error: "not a public registrable domain" };

  const canonical = canonicalDomain(decoded);
  const registrable = registrableDomain(canonical);
  if (!registrable || isJunkDomain(canonical)) return { error: "not a public registrable domain" };
  return { domain: canonical };
}
