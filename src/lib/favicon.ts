// Private/non-routable host ranges. We must NOT emit favicon URLs for these:
// a public page requesting a LAN address (`.local`, localhost, private IP)
// triggers the browser's Local Network Access permission prompt.
const PRIVATE_IP = /^(10|127)\.\d|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./;

/** Favicon URL for a domain, or null when the host isn't publicly routable. */
export function faviconUrl(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (!d.includes(".")) return null; // single-label host (not a public FQDN)
  if (d === "localhost" || d.endsWith(".local") || d.endsWith(".internal") || d.endsWith(".localhost")) return null;
  if (PRIVATE_IP.test(d)) return null;
  return `https://${domain}/favicon.ico`;
}
