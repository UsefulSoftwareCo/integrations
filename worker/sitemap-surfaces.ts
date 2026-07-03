import { allDomains } from "../src/lib/catalog.ts";

const SITE = "https://integrations.sh";

/**
 * INTEGRATOR: in worker/entry.ts, before the Astro fallthrough:
 *
 *   import { sitemapSurfacesResponse } from "./sitemap-surfaces.ts";
 *   if (url.pathname === "/sitemap-surfaces.xml") return sitemapSurfacesResponse();
 */

/** Domain listing pages only — surface slugs live in KV and are not enumerated here. */
export function sitemapSurfacesXml(): string {
  const urls = allDomains()
    .map((d) => `  <url><loc>${SITE}/${encodeURIComponent(d.domain)}/</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

export function sitemapSurfacesResponse(): Response {
  return new Response(sitemapSurfacesXml(), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
