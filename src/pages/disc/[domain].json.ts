/**
 * Per-domain baseline discovery JSON — `/disc/{domain}.json`.
 *
 * The static catalog expressed in the discovery format, one file per domain,
 * plus the domain page's catalog seed. The worker reads this for surface
 * detail pages and for SSR'ing the domain page when a stored discovery exists
 * (merged with the live KV result), so every surface — catalog or discovered —
 * derives from the same format. Emitted at build via getStaticPaths.
 */
import type { APIRoute } from "astro";
import type { Integration } from "~/lib/types.ts";
import { all, domainById, index } from "~/lib/data.ts";
import type { IndexRecord } from "~/lib/data.ts";
import { catalogDiscovery } from "~/lib/catalog-to-discovery.ts";
import { catalogSeed } from "~/lib/domain-seed.ts";

const groups = new Map<string, Integration[]>();
for (const r of all) {
  const domain = domainById.get(r.id) || r.slug;
  if (!domain) continue;
  (groups.get(domain) ?? groups.set(domain, []).get(domain)!).push(r);
}

const indexGroups = new Map<string, IndexRecord[]>();
for (const r of index) {
  const d = r.domain || r.slug;
  if (!d) continue;
  (indexGroups.get(d) ?? indexGroups.set(d, []).get(d)!).push(r);
}

export function getStaticPaths() {
  return [...groups.keys()].map((domain) => ({ params: { domain } }));
}

export const GET: APIRoute = ({ params }) => {
  const domain = params.domain ?? "";
  const body = {
    ...catalogDiscovery(domain, groups.get(domain) ?? []),
    catalog: catalogSeed(indexGroups.get(domain) ?? []),
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
