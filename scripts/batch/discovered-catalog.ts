import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDomain } from "tldts";
import type { AuthStatus, StoredDiscovery, Surface } from "../../src/lib/discovery-schema.ts";
import { canonicalDomain } from "../../src/lib/domain-aliases.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
export const DEFAULT_DOMAIN_CATALOG_DIR = join(ROOT, "domains");

export type CatalogPackage = {
  registryType: string;
  identifier: string;
  runtimeHint?: string;
};

export type CatalogSurface = {
  slug: string;
  name: string;
  type: Surface["type"];
  url?: string;
  spec?: string;
  command?: string;
  packages?: CatalogPackage[];
  authStatus: AuthStatus["status"];
};

export type CatalogDomain = {
  domain: string;
  description?: string;
  summary: string;
  discoveredAt?: string;
  surfaces: CatalogSurface[];
};

export type Catalog = {
  domains: CatalogDomain[];
};

export type CatalogMergeStats = {
  new: number;
  updated: number;
  unchanged: number;
};

export type CatalogMergeResult = {
  catalog: Catalog;
  stats: CatalogMergeStats;
  changes: Array<{ kind: "new" | "updated"; domain: string; previousDiscoveredAt?: string; nextDiscoveredAt?: string }>;
};

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

export function catalogDomainKey(input: string | undefined): string | null {
  const domain = input?.trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain.startsWith("__")) return null;
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".")) return null;
  const info = parseDomain(`https://${domain}`, { allowPrivateDomains: true });
  if (info.isIp || !info.domain || !(info.isIcann || info.isPrivate)) return null;
  const canonical = canonicalDomain(domain);
  const canonicalInfo = parseDomain(`https://${canonical}`, { allowPrivateDomains: true });
  if (canonicalInfo.isIp || !canonicalInfo.domain || !(canonicalInfo.isIcann || canonicalInfo.isPrivate)) return null;
  return canonical;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authStatusValue(value: unknown): AuthStatus["status"] {
  return value === "none" || value === "required" || value === "unknown" ? value : "unknown";
}

function compactPackages(value: unknown): CatalogPackage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const packages = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const registryType = stringValue(item.registryType);
    const identifier = stringValue(item.identifier);
    if (!registryType || !identifier) return [];
    const runtimeHint = stringValue(item.runtimeHint);
    return [{ registryType, identifier, ...(runtimeHint ? { runtimeHint } : {}) }];
  });
  return packages.length ? packages : undefined;
}

export function compactSurface(surface: Surface): CatalogSurface {
  const out: CatalogSurface = {
    slug: surface.slug,
    name: surface.name,
    type: surface.type,
    authStatus: surface.auth.status,
  };
  if ("url" in surface && surface.url) out.url = surface.url;
  if ("spec" in surface && surface.spec) out.spec = surface.spec;
  if (surface.type === "cli") {
    if (surface.command) out.command = surface.command;
    if (surface.packages?.length) out.packages = compactPackages(surface.packages);
  }
  return out;
}

function compactLooseSurface(value: unknown): CatalogSurface | null {
  if (!isRecord(value)) return null;
  const slug = stringValue(value.slug);
  const name = stringValue(value.name);
  const rawType = stringValue(value.type);
  if (!slug || !name || !rawType) return null;
  const type = rawType === "openapi" || rawType === "rest" ? "http" : rawType;
  if (type !== "http" && type !== "graphql" && type !== "mcp" && type !== "cli") return null;

  const auth = isRecord(value.auth) ? authStatusValue(value.auth.status) : authStatusValue(value.authStatus);
  const out: CatalogSurface = { slug, name, type, authStatus: auth };
  const url = stringValue(value.url);
  const spec = stringValue(value.spec);
  const command = stringValue(value.command);
  if (url) out.url = url;
  if (spec) out.spec = spec;
  if (type === "cli") {
    if (command) out.command = command;
    const packages = compactPackages(value.packages);
    if (packages) out.packages = packages;
  }
  return out;
}

export function catalogDomainFromStored(stored: StoredDiscovery): CatalogDomain | null {
  const result = stored.result;
  const surfaces = (result.surfaces ?? []).map(compactSurface);
  return {
    domain: result.domain.toLowerCase(),
    description: result.description,
    summary: result.summary,
    discoveredAt: stored.discoveredAt || result.discoveredAt,
    surfaces,
  };
}

export function catalogDomainFromLooseStored(value: unknown, fallbackDomain?: string): CatalogDomain | null {
  if (!isRecord(value)) return null;
  const result = isRecord(value.result) ? value.result : value;
  const domain = stringValue(result.domain) ?? fallbackDomain;
  if (!domain) return null;
  const surfaces = (Array.isArray(result.surfaces) ? result.surfaces : []).flatMap((surface) => {
    const compact = compactLooseSurface(surface);
    return compact ? [compact] : [];
  });
  const summary = stringValue(result.summary) ?? stringValue(result.description) ?? `${domain.toLowerCase()} integration surfaces`;
  const discoveredAt = stringValue(value.discoveredAt) ?? stringValue(result.discoveredAt);
  return {
    domain: domain.toLowerCase(),
    description: stringValue(result.description),
    summary,
    ...(discoveredAt ? { discoveredAt } : {}),
    surfaces,
  };
}

function discoveredTime(domain: CatalogDomain): number {
  if (!domain.discoveredAt) return 0;
  const time = Date.parse(domain.discoveredAt);
  return Number.isFinite(time) ? time : 0;
}

function domainFilePath(root: string, canonical: string): string {
  return join(root, canonical, "integrations.json");
}

export function listDomainCatalogFiles(root = DEFAULT_DOMAIN_CATALOG_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => domainFilePath(root, entry.name))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .sort();
}

export function readDomainCatalogFile(path: string): CatalogDomain {
  return JSON.parse(readFileSync(path, "utf8")) as CatalogDomain;
}

export function readDomainCatalogTree(root = DEFAULT_DOMAIN_CATALOG_DIR): Catalog {
  const domains = listDomainCatalogFiles(root)
    .map(readDomainCatalogFile)
    .filter((domain) => catalogDomainKey(domain.domain) !== null)
    .sort((a, b) => {
      const aKey = catalogDomainKey(a.domain) ?? a.domain;
      const bKey = catalogDomainKey(b.domain) ?? b.domain;
      return aKey.localeCompare(bKey) || a.domain.localeCompare(b.domain);
    });
  return { domains };
}

export function writeDomainCatalogTree(
  root: string,
  domains: readonly CatalogDomain[],
): { written: number; changed: number; skipped: Array<{ domain: string; reason: string }> } {
  let written = 0;
  let changed = 0;
  const skipped: Array<{ domain: string; reason: string }> = [];

  const rows = [...domains].sort((a, b) => {
    const aKey = catalogDomainKey(a.domain) ?? a.domain;
    const bKey = catalogDomainKey(b.domain) ?? b.domain;
    return aKey.localeCompare(bKey) || a.domain.localeCompare(b.domain);
  });

  for (const domain of rows) {
    const key = catalogDomainKey(domain.domain);
    if (!key) {
      skipped.push({ domain: domain.domain, reason: "invalid registrable domain" });
      continue;
    }
    const path = domainFilePath(root, key);
    const next = stableJson(domain);
    const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    mkdirSync(join(path, ".."), { recursive: true });
    if (before !== next) {
      writeFileSync(path, next);
      changed++;
    }
    written++;
  }

  return { written, changed, skipped };
}

export function mergeCatalogs(existing: Catalog, incomingDomains: readonly CatalogDomain[]): CatalogMergeResult {
  const byCanonical = new Map<string, CatalogDomain>();
  for (const domain of existing.domains ?? []) {
    const key = catalogDomainKey(domain.domain);
    if (!key) continue;
    const prior = byCanonical.get(key);
    if (!prior || discoveredTime(domain) > discoveredTime(prior)) byCanonical.set(key, domain);
  }

  const stats: CatalogMergeStats = { new: 0, updated: 0, unchanged: 0 };
  const changes: CatalogMergeResult["changes"] = [];
  const touched = new Set<string>();

  for (const incoming of incomingDomains) {
    const key = catalogDomainKey(incoming.domain);
    if (!key) continue;
    touched.add(key);
    const prior = byCanonical.get(key);
    if (!prior) {
      byCanonical.set(key, incoming);
      stats.new++;
      changes.push({ kind: "new", domain: incoming.domain, nextDiscoveredAt: incoming.discoveredAt });
      continue;
    }

    const priorTime = discoveredTime(prior);
    const incomingTime = discoveredTime(incoming);
    if (incomingTime > priorTime) {
      byCanonical.set(key, incoming);
      stats.updated++;
      changes.push({
        kind: "updated",
        domain: incoming.domain,
        previousDiscoveredAt: prior.discoveredAt,
        nextDiscoveredAt: incoming.discoveredAt,
      });
    } else {
      stats.unchanged++;
    }
  }

  for (const key of byCanonical.keys()) {
    if (!touched.has(key)) stats.unchanged++;
  }

  const domains = [...byCanonical.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, domain]) => domain);
  return { catalog: { domains }, stats, changes };
}
