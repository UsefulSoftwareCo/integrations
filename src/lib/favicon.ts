import { parse } from "tldts";

const JUNK_TLDS = new Set(["local", "test", "internal", "example"]);
const JUNK_HOSTING_SUFFIXES = [
  "workers.dev",
  "awsapprunner.com",
  "azurewebsites.net",
  "cloudfront.net",
  "onrender.com",
  "appspot.com",
];

/**
 * Icon URL for an already-trusted host (e.g. the domain segment of a page we
 * are rendering) — the /logo proxy (context.dev Logo Link behind the edge
 * cache, Google favicon fallback; see worker/entry.ts). Relative, for use in
 * pages and islands served from integrations.sh itself. The proxy re-validates
 * the domain, so unvalidated input degrades to a 400 + the <img> onerror path.
 */
export function faviconFor(host: string): string {
  return `/logo/${encodeURIComponent(host)}`;
}

/**
 * Icon URL for a domain, or null when it isn't a real public registrable
 * domain. Validated against the Public Suffix List (via tldts), including the
 * PSL's *private* section so platform-hosted apps resolve to their own host
 * (app.vercel.app, user.github.io, bucket.s3.amazonaws.com) rather than the
 * platform. Excludes `.local`/`.internal` hosts, single-label names, IPs, and
 * invalid TLDs — requesting an icon for any of those is wrong.
 *
 * Points at our own /logo proxy — the same source executor uses. Absolute,
 * because these URLs are also published in api.json for external consumers.
 */
export function faviconUrl(domain: string | null | undefined): string | null {
  const registrable = registrableDomain(domain);
  return registrable ? `https://integrations.sh/logo/${registrable}` : null;
}

/** The registrable domain behind `faviconUrl`'s validation, for callers that
 * need the domain itself (the /logo proxy route) rather than a favicon URL. */
export function registrableDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const info = parse(domain, { allowPrivateDomains: true });
  if (info.isIp || !info.domain || !(info.isIcann || info.isPrivate)) return null;
  return info.domain;
}

function normalizeHost(domain: string | null | undefined): string {
  const raw = (domain ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/\.$/, "");
  } catch {
    return raw.split("/")[0].split(":")[0] ?? "";
  }
}

function vowelRatio(s: string): number {
  const vowels = s.match(/[aeiou]/g)?.length ?? 0;
  return vowels / Math.max(s.length, 1);
}

function looksGeneratedLabel(label: string): boolean {
  const parts = label.split("-").filter(Boolean);
  return parts.some((part) => {
    if (/^\d{10,}$/.test(part)) return true;
    if (/^[a-f0-9]{16,}$/.test(part) && /\d/.test(part) && /[a-f]/.test(part)) return true;
    if (/^[a-z0-9]{9,}$/.test(part) && /\d/.test(part) && /[a-z]/.test(part) && vowelRatio(part) <= 0.25) return true;
    if (/^[a-z]{16,}$/.test(part) && vowelRatio(part) <= 0.2) return true;
    return false;
  });
}

/** Domains that are implementation hosts, fixtures, or generated deployment
 * names rather than durable public service domains. */
export function isJunkDomain(domain: string | null | undefined): boolean {
  const host = normalizeHost(domain);
  if (!host) return false;
  const labels = host.split(".").filter(Boolean);
  const tld = labels[labels.length - 1];
  if (tld && JUNK_TLDS.has(tld)) return true;
  if (JUNK_HOSTING_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;

  const info = parse(host, { allowPrivateDomains: true });
  const domainLabel = info.domainWithoutSuffix || labels[0] || "";
  const subdomainLabels = (info.subdomain || "").split(".").filter(Boolean);
  return labels.length > 2 && [domainLabel, ...subdomainLabels].some(looksGeneratedLabel);
}
