import type { APIRoute } from "astro";
import { registrableDomain } from "../../lib/favicon.ts";

export const prerender = false;

/**
 * Dev-only stand-in for the /logo proxy. In production the Worker entry
 * (worker/entry.ts) handles /logo/{domain} before the request reaches Astro,
 * so this route never runs there; under `astro dev` there is no Worker and
 * logos would 404. Redirect to the production proxy so dev pages render the
 * same icons.
 */
export const GET: APIRoute = ({ params }) => {
  const domain = registrableDomain(params.domain?.trim().toLowerCase());
  if (!domain) return new Response(JSON.stringify({ error: "invalid domain" }), { status: 400 });
  return Response.redirect(`https://integrations.sh/logo/${domain}`, 302);
};
