import type { Env } from "./env.ts";
import type { DiscoverData } from "../src/lib/surface-sections.ts";

/** The domain page's render source: durable discovery result first, then the
 * prerendered baseline discovery JSON. */
export async function discoveryDoc(env: Env, origin: string, domain: string): Promise<DiscoverData | null> {
  try {
    const raw = await env.DISCOVERY.get(domain);
    if (raw) {
      const stored = JSON.parse(raw) as { result?: DiscoverData; discoveredAt?: string };
      if (stored.result?.surfaces?.length) {
        return { ...stored.result, discoveredAt: stored.result.discoveredAt ?? stored.discoveredAt };
      }
    }
    const res = await env.ASSETS.fetch(`${origin}/disc/${encodeURIComponent(domain)}.json`);
    if (res.ok) {
      const baseline = (await res.json()) as DiscoverData;
      if (baseline.surfaces?.length) return baseline;
    }
  } catch {
    /* unavailable or malformed discovery data */
  }
  return null;
}
