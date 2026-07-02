import type { APIRoute } from "astro";
import { apiEnvelope } from "~/lib/api-envelope.ts";
import { allDomains } from "~/lib/catalog.ts";

// GET /api/domains.json — the registry's domains (popularity-sorted), the same
// data the homepage and /browse pages render server-side. Prerendered at build.
export const GET: APIRoute = () =>
  new Response(JSON.stringify(apiEnvelope(allDomains())), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  });
