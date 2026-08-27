import type { Env } from "./env.ts";
import type { DiscoverData } from "../src/lib/surface-sections.ts";
import { aliasesOf, canonicalDomain } from "../src/lib/domain-aliases.ts";
import { isSdkNotCli } from "../src/lib/surface-classify.ts";

export async function discoveryKvGet(env: Env, domain: string): Promise<string | null> {
  const canonical = canonicalDomain(domain);
  const raw = await env.DISCOVERY.get(canonical);
  if (raw) return raw;
  for (const alias of aliasesOf(canonical)) {
    const aliasRaw = await env.DISCOVERY.get(alias);
    if (aliasRaw) return aliasRaw;
  }
  return null;
}

/** Drop client SDKs/libraries mis-typed as `cli` — they are not a surface. This
 * loader feeds the `/api/{domain}/discovery` JSON endpoint (the island's mount
 * fetch) and the OG image, so filtering here keeps them consistent with the
 * SSR'd pages. */
type DiscoveryDocWithSurfaces = DiscoverData & { surfaces: NonNullable<DiscoverData["surfaces"]> };

const hasSurfaceArray = (doc: DiscoverData | undefined): doc is DiscoveryDocWithSurfaces =>
  Array.isArray(doc?.surfaces);

const stripSdkSurfaces = (doc: DiscoveryDocWithSurfaces): DiscoveryDocWithSurfaces => ({
  ...doc,
  surfaces: doc.surfaces.filter((s) => !isSdkNotCli(s)),
});

type SurfaceLike = {
  type?: string;
  url?: string;
  spec?: string;
  slug?: string;
};

/** The machine locator per surface type — what a consumer needs to actually
 * connect (an http surface's docs page or base URL is not it). */
const locatorField = (type: string | undefined): "spec" | "url" | null =>
  type === "http" || type === "graphql" ? "spec" : type === "mcp" ? "url" : null;

// GraphQL's connectable locator is really the endpoint; treat a surface as
// machine-reachable when either the endpoint or the SDL pointer is present.
const hasLocator = (s: SurfaceLike): boolean =>
  s.type === "graphql" ? !!(s.url ?? s.spec) : !!s[locatorField(s.type) ?? "url"];

/**
 * Live-discovered docs sometimes drop the machine locators the static catalog
 * carries (the LLM found the API but not its spec URL). Backfill from the
 * baseline, conservatively, per surface type:
 * - any stored surface of the type already has a locator → leave the type alone;
 * - exactly one stored surface and one locator-bearing baseline candidate →
 *   fill the stored surface's missing `spec`/`url`;
 * - otherwise append the baseline's locator-bearing surfaces (slug-deduped),
 *   so registry-known specs stay reachable alongside the discovered surface.
 */
const backfillBaselineLocators = (
  stored: DiscoveryDocWithSurfaces,
  baseline: DiscoveryDocWithSurfaces,
): DiscoveryDocWithSurfaces => {
  const surfaces: SurfaceLike[] = [...stored.surfaces];
  const takenSlugs = new Set(surfaces.map((s) => s.slug).filter(Boolean));
  for (const type of ["http", "graphql", "mcp"]) {
    const storedOfType = surfaces.filter((s) => s.type === type);
    if (storedOfType.some(hasLocator)) continue;
    const candidates = (baseline.surfaces as SurfaceLike[]).filter(
      (s) => s.type === type && hasLocator(s),
    );
    if (candidates.length === 0) continue;
    if (storedOfType.length === 1 && candidates.length === 1) {
      const target = storedOfType[0]!;
      const source = candidates[0]!;
      if (!target.spec && source.spec) target.spec = source.spec;
      if (!target.url && source.url) target.url = source.url;
      continue;
    }
    for (const candidate of candidates) {
      if (candidate.slug && takenSlugs.has(candidate.slug)) continue;
      if (candidate.slug) takenSlugs.add(candidate.slug);
      surfaces.push(candidate);
    }
  }
  return { ...stored, surfaces: surfaces as DiscoveryDocWithSurfaces["surfaces"] };
};

const baselineDoc = async (
  env: Env,
  origin: string,
  canonical: string,
): Promise<DiscoveryDocWithSurfaces | null> => {
  const res = await env.ASSETS.fetch(`${origin}/disc/${encodeURIComponent(canonical)}.json`);
  if (!res.ok) return null;
  const baseline = (await res.json()) as DiscoverData;
  return hasSurfaceArray(baseline) ? baseline : null;
};

/** The domain page's render source: durable discovery result first (with
 * missing machine locators backfilled from the baseline), then the prerendered
 * baseline discovery JSON. */
export async function discoveryDoc(env: Env, origin: string, domain: string): Promise<DiscoverData | null> {
  const canonical = canonicalDomain(domain);
  try {
    const raw = await discoveryKvGet(env, canonical);
    if (raw) {
      const stored = JSON.parse(raw) as { result?: DiscoverData; discoveredAt?: string };
      if (hasSurfaceArray(stored.result)) {
        const doc = { ...stored.result, discoveredAt: stored.result.discoveredAt ?? stored.discoveredAt };
        const baseline = await baselineDoc(env, origin, canonical);
        return stripSdkSurfaces(baseline ? backfillBaselineLocators(doc, baseline) : doc);
      }
    }
    const baseline = await baselineDoc(env, origin, canonical);
    if (baseline) return stripSdkSurfaces(baseline);
  } catch {
    /* unavailable or malformed discovery data */
  }
  return null;
}
