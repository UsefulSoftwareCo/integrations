import { getDomain as tldGetDomain } from "tldts";
import { canonicalDomain } from "./domain-aliases.ts";
import type { CatalogDomain } from "./discovered-catalog.ts";

const getDomain = (value: string) => tldGetDomain(value, { allowPrivateDomains: true });

export function discoveredTargetDomains(entry: CatalogDomain): string[] {
  const targets = new Set<string>();
  targets.add(canonicalDomain(entry.domain));
  for (const surface of entry.surfaces) {
    for (const value of [surface.url, surface.spec]) {
      if (!value) continue;
      const domain = getDomain(value);
      if (domain) targets.add(canonicalDomain(domain));
    }
  }
  return [...targets];
}

function surfaceMatchCount(entry: CatalogDomain, target: string): number {
  let count = 0;
  for (const surface of entry.surfaces) {
    for (const value of [surface.url, surface.spec]) {
      if (!value) continue;
      const domain = getDomain(value);
      if (domain && canonicalDomain(domain) === target) count++;
    }
  }
  return count;
}

function outranks(target: string, next: CatalogDomain, current: CatalogDomain): boolean {
  const nextExact = canonicalDomain(next.domain) === target;
  const currentExact = canonicalDomain(current.domain) === target;
  if (nextExact !== currentExact) return nextExact;

  const nextMatches = surfaceMatchCount(next, target);
  const currentMatches = surfaceMatchCount(current, target);
  if (nextMatches !== currentMatches) return nextMatches > currentMatches;

  if (next.surfaces.length !== current.surfaces.length) return next.surfaces.length > current.surfaces.length;

  return next.domain.length < current.domain.length;
}

export function discoveredDomainsByTarget(entries: readonly CatalogDomain[]): Map<string, CatalogDomain> {
  const map = new Map<string, CatalogDomain>();
  for (const entry of entries) {
    for (const domain of discoveredTargetDomains(entry)) {
      const current = map.get(domain);
      if (!current || outranks(domain, entry, current)) map.set(domain, entry);
    }
  }
  return map;
}
