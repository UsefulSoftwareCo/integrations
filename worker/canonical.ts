const CANONICAL_HOST = "integrations.sh";

/**
 * 301 non-canonical hosts (www.*, *.workers.dev, etc.) to https://integrations.sh.
 * Returns a redirect Response, or null when the request should proceed.
 *
 * INTEGRATOR: at the top of the fetch handler in worker/entry.ts (immediately after
 * `const url = new URL(request.url);`), add:
 *
 *   import { canonicalRedirect } from "./canonical.ts";
 *   const canonical = canonicalRedirect(request);
 *   if (canonical) return canonical;
 */
export function canonicalRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return null;
  if (url.hostname === CANONICAL_HOST) return null;
  const target = new URL(url.pathname + url.search, `https://${CANONICAL_HOST}`);
  return Response.redirect(target.toString(), 301);
}
