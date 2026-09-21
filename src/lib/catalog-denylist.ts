/**
 * Catalog denylist — domains that must never become catalog records.
 *
 * WHY. A record can enter the catalog through the public discovery button and
 * the KV sync with no ownership check. Deleting its `domains/` file does not
 * hold: the next sync re-imports whatever KV still holds. The denylist is the
 * durable rejection: every path that reads or writes a record consults it —
 * sync, build, render, and the worker's discovery write path.
 *
 * Matching is by canonical domain, and a listed domain also covers its
 * subdomains (`example.com` covers `api.example.com`).
 */
import denylistJson from "../../catalog-denylist.json";
import { canonicalDomain } from "./domain-aliases.ts";

export interface DenylistEntry {
  readonly domain: string;
  readonly reason: string;
  readonly addedAt: string;
}

const entries: readonly DenylistEntry[] = (denylistJson as { domains: DenylistEntry[] }).domains;

const normalize = (domain: string): string => canonicalDomain(domain.trim().toLowerCase().replace(/\.$/, ""));

const denied = new Map<string, DenylistEntry>(entries.map((e) => [normalize(e.domain), e]));

/** The denylist entry covering `domain` (itself or a parent), or null. */
export function denylistEntry(domain: string | null | undefined): DenylistEntry | null {
  if (!domain) return null;
  const host = normalize(domain);
  if (!host) return null;
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    const hit = denied.get(candidate);
    if (hit) return hit;
  }
  return null;
}

export function isDenylisted(domain: string | null | undefined): boolean {
  return denylistEntry(domain) !== null;
}

export function denylistEntries(): readonly DenylistEntry[] {
  return entries;
}
