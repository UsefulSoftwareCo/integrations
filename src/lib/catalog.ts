/**
 * Catalog query layer — the single data-loading path for the registry listing.
 *
 * Both the public JSON endpoint (`/api/domains.json`) and the server-rendered
 * pages call these functions, so SSR goes through the same "API" everyone else
 * uses (no ad-hoc grouping in templates). Built over the enriched index.
 */
import { index } from "./data.ts";
import { faviconUrl, isJunkDomain } from "./favicon.ts";
import type { Kind } from "./types.ts";

export interface DomainSummary {
  domain: string;
  icon: string | null;
  total: number;
  formats: Partial<Record<Kind, number>>;
  popularity: number;
  devtool: boolean;
  description: string;
}

const KIND_ORDER: Kind[] = ["mcp", "openapi", "graphql", "cli"];

const DOMAINS: DomainSummary[] = (() => {
  const map = new Map<string, DomainSummary>();
  for (const r of index) {
    const d = r.domain || r.slug;
    if (!d) continue;
    if (isJunkDomain(d)) continue;
    let g = map.get(d);
    if (!g) {
      g = { domain: d, icon: faviconUrl(d), total: 0, formats: {}, popularity: 0, devtool: false, description: "" };
      map.set(d, g);
    }
    g.total++;
    g.formats[r.kind] = (g.formats[r.kind] ?? 0) + 1;
    g.popularity = Math.max(g.popularity, r.popularity ?? 0);
    g.devtool ||= r.devtool === true;
    if (!g.description && r.description) g.description = r.description.replace(/\s+/g, " ").slice(0, 110);
  }
  // Dev tools first — the audience's daily drivers — then popularity.
  return [...map.values()].sort(
    (a, b) => Number(b.devtool) - Number(a.devtool) || b.popularity - a.popularity || b.total - a.total || a.domain.localeCompare(b.domain),
  );
})();

/** Formats present on a domain, in canonical order. */
export const formatsOf = (d: DomainSummary): Kind[] => KIND_ORDER.filter((k) => d.formats[k]);

/** All domains, popularity-sorted. The full list the JSON endpoint serves. */
export function allDomains(): DomainSummary[] {
  return DOMAINS;
}

/** A page of domains — what each server-rendered listing renders. */
export function listDomains(opts?: { offset?: number; limit?: number }): DomainSummary[] {
  const offset = opts?.offset ?? 0;
  return opts?.limit != null ? DOMAINS.slice(offset, offset + opts.limit) : DOMAINS.slice(offset);
}

export function domainCount(): number {
  return DOMAINS.length;
}
