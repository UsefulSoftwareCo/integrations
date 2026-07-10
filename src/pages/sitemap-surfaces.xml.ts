import type { APIRoute } from "astro";
import { curatedProviderForDomain } from "~/lib/curated.ts";
import { all, domainById } from "~/lib/data.ts";
import { readDomainCatalogTree } from "~/lib/discovered-catalog.ts";
import { discoveredDomainsByTarget } from "~/lib/discovered-domains.ts";
import { buildDomainDiscovery } from "~/lib/domain-discovery.ts";
import { baselineDiscoveryGroups } from "~/lib/catalog-to-discovery.ts";

export const prerender = true;

const SITE = "https://integrations.sh";
const RESERVED_SURFACE_SLUGS = new Set(["api", "disc", "ssr"]);

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

const groups = baselineDiscoveryGroups(all, (r) => domainById.get(r.id) || r.slug);
const discoveredByDomain = discoveredDomainsByTarget(readDomainCatalogTree().domains);

export const GET: APIRoute = () => {
  const urls: string[] = [];
  for (const [domain, records] of groups) {
    const doc = buildDomainDiscovery(
      domain,
      records,
      discoveredByDomain.get(domain) ?? null,
      curatedProviderForDomain(domain),
    );
    for (const surface of doc.surfaces) {
      if (RESERVED_SURFACE_SLUGS.has(surface.slug.toLowerCase())) continue;
      const loc = new URL(`/${encodeURIComponent(domain)}/${encodeURIComponent(surface.slug)}/`, SITE).href;
      urls.push(`  <url><loc>${escapeXml(loc)}</loc></url>`);
    }
  }

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
