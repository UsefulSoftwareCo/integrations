/**
 * Per-domain baseline discovery JSON — `/disc/{domain}.json`.
 *
 * Locator-bearing baseline discovery data, one file per domain. The worker
 * reads this for surface detail pages, OG cards, slug continuity, and as the
 * domain-page fallback when no KV row exists. Catalog-only records do not
 * produce baseline surfaces here. Emitted at build via getStaticPaths.
 */
import type { APIRoute } from "astro";
import { curatedProviderForDomain } from "~/lib/curated.ts";
import { all, domainById } from "~/lib/data.ts";
import { readDomainCatalogTree } from "~/lib/discovered-catalog.ts";
import { discoveredDomainsByTarget } from "~/lib/discovered-domains.ts";
import { buildDomainDiscovery } from "~/lib/domain-discovery.ts";
import { allDomains } from "~/lib/catalog.ts";
import { baselineDiscoveryGroups } from "~/lib/catalog-to-discovery.ts";

const groups = baselineDiscoveryGroups(all, (r) => domainById.get(r.id) || r.slug);
const discoveredByDomain = discoveredDomainsByTarget(readDomainCatalogTree().domains);

export function getStaticPaths() {
  return allDomains().map(({ domain }) => ({ params: { domain } }));
}

export const GET: APIRoute = ({ params }) => {
  const domain = params.domain ?? "";
  const body = buildDomainDiscovery(
    domain,
    groups.get(domain) ?? [],
    discoveredByDomain.get(domain) ?? null,
    curatedProviderForDomain(domain),
  );
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
