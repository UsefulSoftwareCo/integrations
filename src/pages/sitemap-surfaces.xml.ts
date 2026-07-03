import type { APIRoute } from "astro";
import { all, domainById } from "~/lib/data.ts";
import { baselineDiscoveryGroups, catalogDiscovery } from "~/lib/catalog-to-discovery.ts";

export const prerender = true;

const SITE = "https://integrations.sh";

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

const groups = baselineDiscoveryGroups(all, (r) => domainById.get(r.id) || r.slug);

export const GET: APIRoute = () => {
  const urls: string[] = [];
  for (const [domain, records] of groups) {
    const doc = catalogDiscovery(domain, records);
    for (const surface of doc.surfaces) {
      const loc = new URL(`/${encodeURIComponent(domain)}/${encodeURIComponent(surface.slug)}/`, SITE).href;
      urls.push(`  <url><loc>${escapeXml(loc)}</loc></url>`);
    }
  }

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
