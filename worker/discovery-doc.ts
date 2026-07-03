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
const stripSdkSurfaces = (doc: DiscoverData): DiscoverData =>
  doc.surfaces?.length ? { ...doc, surfaces: doc.surfaces.filter((s) => !isSdkNotCli(s)) } : doc;

/** The domain page's render source: durable discovery result first, then the
 * prerendered baseline discovery JSON. */
export async function discoveryDoc(env: Env, origin: string, domain: string): Promise<DiscoverData | null> {
  const canonical = canonicalDomain(domain);
  try {
    const raw = await discoveryKvGet(env, canonical);
    if (raw) {
      const stored = JSON.parse(raw) as { result?: DiscoverData; discoveredAt?: string };
      if (stored.result?.surfaces?.length) {
        return stripSdkSurfaces({ ...stored.result, discoveredAt: stored.result.discoveredAt ?? stored.discoveredAt });
      }
    }
    const res = await env.ASSETS.fetch(`${origin}/disc/${encodeURIComponent(canonical)}.json`);
    if (res.ok) {
      const baseline = (await res.json()) as DiscoverData;
      if (baseline.surfaces?.length) return stripSdkSurfaces(baseline);
    }
  } catch {
    /* unavailable or malformed discovery data */
  }
  return null;
}
