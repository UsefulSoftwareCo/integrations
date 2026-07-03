/** Alias domain -> canonical domain. One vendor, one canonical bucket. */
export const DOMAIN_ALIASES: Record<string, string> = {
  "sentry.io": "sentry.dev",
  "vercel.sh": "vercel.com",
  "zeit.co": "vercel.com",
  "railway.app": "railway.com",
};

export function assertValidDomainAliases(aliases: Record<string, string>): void {
  for (const [alias, canonical] of Object.entries(aliases)) {
    const normalizedAlias = alias.toLowerCase().trim();
    const normalizedCanonical = canonical.toLowerCase().trim();
    if (!normalizedAlias || !normalizedCanonical) {
      throw new Error(`Invalid domain alias: ${alias} -> ${canonical}`);
    }
    if (normalizedAlias !== alias || normalizedCanonical !== canonical) {
      throw new Error(`Domain aliases must already be normalized: ${alias} -> ${canonical}`);
    }
    if (normalizedAlias === normalizedCanonical) {
      throw new Error(`Domain alias points to itself: ${alias}`);
    }
    if (aliases[normalizedCanonical]) {
      throw new Error(`Domain alias chain/cycle is not allowed: ${alias} -> ${canonical}`);
    }
  }
}

assertValidDomainAliases(DOMAIN_ALIASES);

export function canonicalDomain(domain: string): string {
  const d = domain.toLowerCase().trim();
  return DOMAIN_ALIASES[d] ?? d;
}

/** Canonical -> list of aliases (for redirects / KV fallback lookups). */
export function aliasesOf(canonical: string): string[] {
  const c = canonicalDomain(canonical);
  return Object.entries(DOMAIN_ALIASES)
    .filter(([, target]) => target === c)
    .map(([alias]) => alias)
    .sort();
}
