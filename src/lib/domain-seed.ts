/**
 * The domain page's build-time data shaping, shared by the prerendered page
 * ([domain].astro) and the baked per-domain JSON (/disc/{domain}.json) so the
 * worker can SSR the exact same page at runtime when a stored discovery
 * exists. Build-time only — joins against output/*.json via data.ts.
 */
import { byId } from "./data.ts";
import type { IndexRecord } from "./data.ts";
import type { CatalogSection } from "../components/Surfaces.tsx";
import { KIND_ORDER, SECTION_LABEL } from "./domain-labels.ts";

/** Per-record meta hint shown on the right of each row. The slim index record
 * lacks per-format detail, so join back to the full record via `byId`. */
const metaFor = (r: IndexRecord): string => {
  const full = byId.get(r.id);
  if (r.kind === "mcp") {
    const n = full?.tools?.length ?? full?.mcp?.toolNames?.length ?? 0;
    return n ? `${n} tool${n === 1 ? "" : "s"}` : "mcp";
  }
  if (r.kind === "openapi") return full?.openapi?.version ? `v${full.openapi.version}` : "openapi";
  if (r.kind === "graphql") return full?.graphql?.hasSecurity ? "auth" : "graphql";
  if (r.kind === "cli") return "cli";
  return "";
};

/** Identity for dedup against discovered surfaces (url/spec from the full record). */
const identityFor = (r: IndexRecord): { url?: string; spec?: string } => {
  const full = byId.get(r.id);
  if (r.kind === "mcp") return { url: full?.mcp?.remoteUrl };
  if (r.kind === "openapi") return { spec: full?.openapi?.specUrl };
  if (r.kind === "graphql") return { url: full?.graphql?.endpoint };
  return {};
};

/** Sections in canonical format order, most-popular record first within each. */
export function domainSections(records: IndexRecord[]) {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: SECTION_LABEL[kind],
    items: records
      .filter((r) => r.kind === kind)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.name.localeCompare(b.name)),
  })).filter((s) => s.items.length > 0);
}

/** The catalog seed passed to the Surfaces island — SSR'd for SEO, then merged
 * with discovery (stored or run live). */
export function catalogSeed(records: IndexRecord[]): CatalogSection[] {
  return domainSections(records).map((s) => ({
    kind: s.kind,
    label: s.label,
    items: s.items.map((r) => ({
      name: r.name,
      description: r.description,
      slug: r.slug,
      kind: r.kind,
      meta: metaFor(r),
      ...identityFor(r),
    })),
  }));
}
