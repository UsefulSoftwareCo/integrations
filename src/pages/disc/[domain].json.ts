/**
 * Per-domain baseline discovery JSON — `/disc/{domain}.json`.
 *
 * Locator-bearing baseline discovery data, one file per domain. The worker
 * reads this for surface detail pages, OG cards, slug continuity, and as the
 * domain-page fallback when no KV row exists. Catalog-only records do not
 * produce baseline surfaces here. Emitted at build via getStaticPaths.
 */
import type { APIRoute } from "astro";
import type { Integration } from "~/lib/types.ts";
import { all, domainById } from "~/lib/data.ts";
import { catalogDiscovery } from "~/lib/catalog-to-discovery.ts";

const groups = new Map<string, Integration[]>();
for (const r of all) {
  const domain = domainById.get(r.id) || r.slug;
  if (!domain) continue;
  (groups.get(domain) ?? groups.set(domain, []).get(domain)!).push(r);
}

export function getStaticPaths() {
  return [...groups.keys()].map((domain) => ({ params: { domain } }));
}

export const GET: APIRoute = ({ params }) => {
  const domain = params.domain ?? "";
  const body = catalogDiscovery(domain, groups.get(domain) ?? []);
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
