import type { Env } from "./env.ts";
import type { DiscoverData } from "../src/lib/surface-sections.ts";
import { isSdkNotCli } from "../src/lib/surface-classify.ts";

/** Drop client SDKs/libraries mis-typed as `cli` — they are not a surface. This
 * loader feeds the `/api/{domain}/discovery` JSON endpoint (the island's mount
 * fetch) and the OG image, so filtering here keeps them consistent with the
 * SSR'd pages. */
const stripSdkSurfaces = (doc: DiscoverData): DiscoverData =>
  doc.surfaces?.length ? { ...doc, surfaces: doc.surfaces.filter((s) => !isSdkNotCli(s)) } : doc;

/** The domain page's render source: durable discovery result first, then the
 * prerendered baseline discovery JSON. */
export async function discoveryDoc(env: Env, origin: string, domain: string): Promise<DiscoverData | null> {
  try {
    const raw = await env.DISCOVERY.get(domain);
    if (raw) {
      const stored = JSON.parse(raw) as { result?: DiscoverData; discoveredAt?: string };
      if (stored.result?.surfaces?.length) {
        return stripSdkSurfaces({ ...stored.result, discoveredAt: stored.result.discoveredAt ?? stored.discoveredAt });
      }
    }
    const res = await env.ASSETS.fetch(`${origin}/disc/${encodeURIComponent(domain)}.json`);
    if (res.ok) {
      const baseline = (await res.json()) as DiscoverData;
      if (baseline.surfaces?.length) return stripSdkSurfaces(baseline);
    }
  } catch {
    /* unavailable or malformed discovery data */
  }
  return null;
}
