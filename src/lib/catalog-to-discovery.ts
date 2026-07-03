/**
 * Catalog → discovery format (v3).
 *
 * The discovery JSON (DiscoveryResult — credentials + typed surfaces) is the one
 * format the whole site derives from. The static registry predates it, so this
 * file emits a baseline discovery document only for records that carry a real
 * locator: MCP remote URLs, OpenAPI spec URLs, GraphQL endpoints, or CLI seed
 * commands. Auth from the catalog is thin (it never captured per-method
 * credentials), so surfaces come out as `unknown` (or `none` when the record
 * says so) — live discovery enriches them.
 *
 * Basis is `detected`/`registry`: these came from machine-normalized registries.
 * Slugs are assigned here at build time (slugified name, deduped per domain) —
 * the prerendered pages link to them, and the worker's slug-continuity pass
 * treats them as priors so live discovery keeps the same URLs.
 */
import type { Integration } from "./types.ts";
import { DISCOVERY_VERSION } from "./discovery-schema.ts";
import type { Surface as SurfaceView } from "./surface-view.ts";
import { assignSlug } from "./discover.ts";
import { isJunkDomain } from "./favicon.ts";

const REG_BASIS = { via: "detected" as const, signal: "registry" };

export function isDiscoveredShim(r: { feeds?: readonly string[] }): boolean {
  return r.feeds?.includes("discovered") ?? false;
}

function hasBaselineLocator(r: Integration): boolean {
  if (isDiscoveredShim(r)) return false;
  if (r.kind === "mcp") return !!r.mcp?.remoteUrl;
  if (r.kind === "openapi") return !!r.openapi?.specUrl;
  if (r.kind === "graphql") return !!r.graphql?.endpoint;
  if (r.kind === "cli") return !!r.cli && !!r.slug;
  return false;
}

/** A locator-bearing catalog record as a v3 discovery surface (sans slug —
 * assigned by the caller). */
export function recordToSurface(r: Integration): Omit<SurfaceView, "slug"> | null {
  if (!hasBaselineLocator(r)) return null;
  switch (r.kind) {
    case "mcp":
      return {
        name: r.name,
        type: "mcp",
        docs: r.url,
        basis: REG_BASIS,
        url: r.mcp?.remoteUrl,
        transports: r.mcp?.transport ? [r.mcp.transport] : undefined,
        auth: r.mcp?.isAuthless ? { status: "none", basis: REG_BASIS } : { status: "unknown" },
      };
    case "openapi":
      return { name: r.name, type: "http", docs: r.openapi?.docsUrl ?? r.url, basis: REG_BASIS, spec: r.openapi?.specUrl, url: r.url, auth: { status: "unknown" } };
    case "graphql":
      return {
        name: r.name,
        type: "graphql",
        docs: r.graphql?.docs?.[0]?.url ?? r.url,
        basis: REG_BASIS,
        url: r.graphql?.endpoint,
        auth: r.graphql?.hasSecurity ? { status: "unknown" } : { status: "none", basis: REG_BASIS },
      };
    case "cli":
      return { name: r.name, type: "cli", docs: r.cli?.docs ?? r.url, basis: REG_BASIS, command: r.slug, notes: r.cli?.install, auth: { status: "unknown" } };
    default:
      return null;
  }
}

/** Baseline surface slug per record id. Slug assignment is order-dependent
 * (name collisions dedupe with -2, -3…), so EVERY caller must pass records in
 * the same canonical order — `all`'s order (mcp, openapi, graphql, cli file
 * order), which is what the /disc JSON endpoint and prerendered domain pages
 * group by, so baseline links agree with the baked JSON. */
export function baselineSlugs(records: Integration[]): Map<string, string> {
  const surfaces: { slug: string }[] = [];
  const byRecordId = new Map<string, string>();
  for (const r of records) {
    const s = recordToSurface(r);
    if (!s) continue;
    const slug = assignSlug(s.name, surfaces);
    surfaces.push({ slug });
    byRecordId.set(r.id, slug);
  }
  return byRecordId;
}

/** The baseline DiscoveryResult (v3 shape) for a domain, from locator-bearing records. */
export function catalogDiscovery(domain: string, records: Integration[]) {
  const slugs = baselineSlugs(records);
  const surfaces: SurfaceView[] = [];
  for (const r of records) {
    const s = recordToSurface(r);
    if (s) surfaces.push({ ...s, slug: slugs.get(r.id)! });
  }
  return { version: DISCOVERY_VERSION, domain, summary: "", credentials: {}, surfaces };
}

/** Records grouped the same way the baseline `/disc/{domain}.json` files are
 * emitted. Preserve input order: slug assignment depends on this order. */
export function baselineDiscoveryGroups(records: Integration[], domainOf: (record: Integration) => string | undefined): Map<string, Integration[]> {
  const groups = new Map<string, Integration[]>();
  for (const r of records) {
    const domain = domainOf(r);
    if (!domain || isJunkDomain(domain)) continue;
    (groups.get(domain) ?? groups.set(domain, []).get(domain)!).push(r);
  }
  return groups;
}
