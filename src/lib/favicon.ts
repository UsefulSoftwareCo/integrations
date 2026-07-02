import { parse } from "tldts";

/**
 * Favicon URL for a domain, or null when it isn't a real public registrable
 * domain. Validated against the Public Suffix List (via tldts), including the
 * PSL's *private* section so platform-hosted apps resolve to their own host
 * (app.vercel.app, user.github.io, bucket.s3.amazonaws.com) rather than the
 * platform. Excludes `.local`/`.internal` hosts, single-label names, IPs, and
 * invalid TLDs — requesting a favicon from any of those is wrong, and LAN hosts
 * trigger the browser's Local Network Access permission prompt.
 */
export function faviconUrl(domain: string | null | undefined): string | null {
  const registrable = registrableDomain(domain);
  return registrable ? `https://${registrable}/favicon.ico` : null;
}

/** The registrable domain behind `faviconUrl`'s validation, for callers that
 * need the domain itself (the /logo proxy route) rather than a favicon URL. */
export function registrableDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const info = parse(domain, { allowPrivateDomains: true });
  if (info.isIp || !info.domain || !(info.isIcann || info.isPrivate)) return null;
  return info.domain;
}
