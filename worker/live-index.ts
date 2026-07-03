import { apiEnvelope, unwrapEnvelope, type ApiEnvelope } from "../src/lib/api-envelope.ts";
import type { DomainSummary } from "../src/lib/catalog.ts";
import { canonicalDomain } from "../src/lib/domain-aliases.ts";
import { faviconUrl } from "../src/lib/favicon.ts";
import { isSdkNotCli } from "../src/lib/surface-classify.ts";
import type { SearchIndexEntry } from "../src/lib/search-index.ts";
import type { Kind } from "../src/lib/types.ts";
import type { Env } from "./env.ts";

export const LIVE_INDEX_KEY = "__live_index__";
const LIVE_INDEX_CAP = 2000;
const KIND_ORDER: Kind[] = ["mcp", "openapi", "graphql", "cli"];

export type LiveIndexEntry = {
  domain: string;
  summary?: string;
  kinds: Kind[];
  discoveredAt: string;
};

type LiveDiscoveryResult = {
  domain?: unknown;
  summary?: unknown;
  surfaces?: unknown;
};

type SearchQueryLike = {
  q: string;
  kind?: Kind;
  limit?: number;
};

export type SearchResultRow = {
  domain: string;
  name: string;
  description: string;
  kinds: Kind[];
  url: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function kindOfSurfaceType(type: unknown): Kind | null {
  if (type === "http" || type === "openapi" || type === "rest") return "openapi";
  if (type === "mcp" || type === "graphql" || type === "cli") return type;
  return null;
}

function discoveredTime(value: { discoveredAt?: string }): number {
  if (!value.discoveredAt) return 0;
  const time = Date.parse(value.discoveredAt);
  return Number.isFinite(time) ? time : 0;
}

function normalizeKinds(value: unknown): Kind[] {
  if (!Array.isArray(value)) return [];
  const set = new Set(value.flatMap((kind) => (kindOfSurfaceType(kind) ? [kindOfSurfaceType(kind)!] : [])));
  return KIND_ORDER.filter((kind) => set.has(kind));
}

function normalizeLiveEntry(value: unknown): LiveIndexEntry | null {
  if (!isRecord(value)) return null;
  const domain = stringValue(value.domain);
  const discoveredAt = stringValue(value.discoveredAt);
  if (!domain || !discoveredAt) return null;
  if (domain.startsWith("__") || !domain.includes(".")) return null;
  const kinds = normalizeKinds(value.kinds);
  if (kinds.length === 0) return null;
  const summary = stringValue(value.summary);
  return { domain: canonicalDomain(domain), ...(summary ? { summary } : {}), kinds, discoveredAt };
}

export function normalizeLiveIndex(value: unknown): LiveIndexEntry[] {
  if (!Array.isArray(value)) return [];
  const byDomain = new Map<string, LiveIndexEntry>();
  for (const item of value) {
    const entry = normalizeLiveEntry(item);
    if (!entry) continue;
    const prior = byDomain.get(entry.domain);
    if (!prior || discoveredTime(entry) >= discoveredTime(prior)) byDomain.set(entry.domain, entry);
  }
  return [...byDomain.values()].sort((a, b) => discoveredTime(b) - discoveredTime(a) || a.domain.localeCompare(b.domain));
}

export async function readLiveIndex(env: Env): Promise<LiveIndexEntry[]> {
  const raw = await env.DISCOVERY.get(LIVE_INDEX_KEY);
  if (!raw) return [];
  try {
    return normalizeLiveIndex(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function liveIndexEntryFromResult(result: LiveDiscoveryResult, discoveredAt: string): LiveIndexEntry | null {
  const domain = stringValue(result.domain);
  if (!domain || !Array.isArray(result.surfaces) || result.surfaces.length === 0) return null;
  const kinds = new Set<Kind>();
  for (const surface of result.surfaces) {
    if (!isRecord(surface)) continue;
    if (isSdkNotCli(surface)) continue;
    const kind = kindOfSurfaceType(surface.type);
    if (kind) kinds.add(kind);
  }
  const orderedKinds = KIND_ORDER.filter((kind) => kinds.has(kind));
  if (orderedKinds.length === 0) return null;
  const summary = stringValue(result.summary);
  return { domain: canonicalDomain(domain), ...(summary ? { summary } : {}), kinds: orderedKinds, discoveredAt };
}

export async function upsertLiveIndex(env: Env, result: LiveDiscoveryResult, discoveredAt: string): Promise<void> {
  const entry = liveIndexEntryFromResult(result, discoveredAt);
  if (!entry) return;
  const existing = await readLiveIndex(env);
  const byDomain = new Map(existing.map((item) => [item.domain, item]));
  const prior = byDomain.get(entry.domain);
  if (!prior || discoveredTime(entry) >= discoveredTime(prior)) byDomain.set(entry.domain, entry);

  // Low write volume plus the daily repo sync make read-modify-write races acceptable here.
  const capped = [...byDomain.values()]
    .sort((a, b) => discoveredTime(b) - discoveredTime(a) || a.domain.localeCompare(b.domain))
    .slice(0, LIVE_INDEX_CAP);
  await env.DISCOVERY.put(LIVE_INDEX_KEY, JSON.stringify(capped));
}

function staticDomainSet(index: readonly { domain: string }[]): Set<string> {
  return new Set(index.map((entry) => canonicalDomain(entry.domain)));
}

export function liveEntriesNotInStatic(liveEntries: readonly LiveIndexEntry[], staticEntries: readonly { domain: string }[]): LiveIndexEntry[] {
  const staticDomains = staticDomainSet(staticEntries);
  return liveEntries.filter((entry) => !staticDomains.has(canonicalDomain(entry.domain)));
}

function searchHaystack(entry: { domain: string; summary?: string; description?: string; kinds: readonly Kind[] }): string {
  return [entry.domain, entry.summary ?? entry.description ?? "", ...entry.kinds].join(" ").toLowerCase();
}

export function appendLiveSearchResults(
  query: SearchQueryLike,
  staticIndex: readonly SearchIndexEntry[],
  staticResults: readonly SearchResultRow[],
  liveEntries: readonly LiveIndexEntry[],
): SearchResultRow[] {
  const q = query.q.trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const remaining = limit - staticResults.length;
  if (remaining <= 0) return [...staticResults];

  const liveResults = liveEntriesNotInStatic(liveEntries, staticIndex)
    .filter((entry) => {
      if (query.kind && !entry.kinds.includes(query.kind)) return false;
      return q.length === 0 || searchHaystack(entry).includes(q);
    })
    .slice(0, remaining)
    .map((entry) => ({
      domain: entry.domain,
      name: entry.domain,
      description: entry.summary ?? "",
      kinds: entry.kinds,
      url: `https://integrations.sh/${encodeURIComponent(entry.domain)}/`,
    }));

  return [...staticResults, ...liveResults];
}

export function mergeLiveDomains(staticRows: readonly DomainSummary[], liveEntries: readonly LiveIndexEntry[]): DomainSummary[] {
  const liveRows = liveEntriesNotInStatic(liveEntries, staticRows).map((entry) => {
    const formats = Object.fromEntries(entry.kinds.map((kind) => [kind, 1])) as Partial<Record<Kind, number>>;
    return {
      domain: entry.domain,
      icon: faviconUrl(entry.domain),
      total: entry.kinds.length,
      formats,
      popularity: 0,
      devtool: false,
      description: (entry.summary ?? "").replace(/\s+/g, " ").slice(0, 110),
    } satisfies DomainSummary;
  });
  return [...staticRows, ...liveRows];
}

export async function domainsJsonWithLiveIndex(env: Env, origin: string): Promise<Response> {
  const staticResponse = await env.ASSETS.fetch(`${origin}/api/domains.json`);
  if (!staticResponse.ok) return staticResponse;

  const json = (await staticResponse.json()) as DomainSummary[] | ApiEnvelope<DomainSummary[]>;
  const merged = mergeLiveDomains(unwrapEnvelope(json), await readLiveIndex(env));
  const body = Array.isArray(json) ? apiEnvelope(merged) : { ...json, data: merged };
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=60",
    },
  });
}
