import { parse } from "tldts";

/**
 * Favicon URL for a domain, or null when it isn't a real public registrable
 * domain. Validated against the Public Suffix List (via tldts): we require a
 * registrable domain under an ICANN suffix. This excludes `.local`/`.internal`
 * hosts, single-label names, IP addresses, and invalid TLDs — requesting a
 * favicon from any of those is wrong, and LAN hosts trigger the browser's
 * Local Network Access permission prompt. Multi-part suffixes (gov.in, gov.uk,
 * com.au, …) resolve correctly because the PSL knows them.
 */
export function faviconUrl(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const info = parse(domain);
  if (info.isIp || !info.domain || !info.isIcann) return null;
  return `https://${info.domain}/favicon.ico`;
}
