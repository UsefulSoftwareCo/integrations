/**
 * Per-domain baseline discovery JSON — `/disc/{domain}.json`.
 *
 * Locator-bearing baseline discovery data, one file per domain. The worker
 * reads this for surface detail pages, OG cards, slug continuity, and as the
 * domain-page fallback when no KV row exists. Catalog-only records do not
 * produce baseline surfaces here. Emitted at build via getStaticPaths.
 */
import type { APIRoute } from "astro";
import { all, domainById } from "~/lib/data.ts";
import { baselineDiscoveryGroups, catalogDiscovery } from "~/lib/catalog-to-discovery.ts";

const groups = baselineDiscoveryGroups(all, (r) => domainById.get(r.id) || r.slug);

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
