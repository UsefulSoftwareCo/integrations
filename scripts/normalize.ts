import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDomain as tldGetDomain } from "tldts";
import { aliasesOf, canonicalDomain } from "../src/lib/domain-aliases.ts";

// Registrable domain per the Public Suffix List, with the PSL's private section
// enabled so platform-hosted services resolve to their own host
// (app.vercel.app, user.github.io) instead of collapsing onto the platform.
const getDomain = (url: string) => tldGetDomain(url, { allowPrivateDomains: true });
import type { Integration, Feed, Kind, ExtractedTool } from "../src/lib/types.ts";
import { faviconUrl, isJunkDomain } from "../src/lib/favicon.ts";
import { isSdkNotCli } from "../src/lib/surface-classify.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = join(ROOT, "sources");
const OVERRIDES = join(ROOT, "overrides");
const OUTPUT = join(ROOT, "output");

// Curated developer-tool domains (scripts/batch/seed-domains*.txt) float to
// the top of the registry list — they're the audience's daily drivers.
const DEVTOOL_DOMAINS: Set<string> = (() => {
  const out = new Set<string>();
  const dir = join(ROOT, "scripts", "batch");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!/^seed-domains.*\.txt$/.test(name)) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const d = canonicalDomain(line);
      if (d && !d.startsWith("#")) out.add(d);
    }
  }
  return out;
})();

mkdirSync(OUTPUT, { recursive: true });

const slugify = (s: string) => {
  const base = s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (base) return base;
  // Non-Latin name: hex hash so the slug is stable.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `x-${(h >>> 0).toString(36)}`;
};

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const canonUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return undefined;
  }
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP: claude.json + openai.json -> merged
// ─────────────────────────────────────────────────────────────────────────────

interface ClaudeServer {
  id: string;
  name: string;
  one_liner?: string;
  description?: string;
  icon_url?: string;
  author?: { name?: string; url?: string };
  tool_names?: string[];
  categories?: string[];
  works_with?: string[];
  popularity_score?: number;
  slug?: string;
  directory_url?: string;
  documentation?: string;
  remote?: { url?: string; transport?: string; is_authless?: boolean };
  type?: string;
}

interface OpenAIConnector {
  id: string;
  connectorType: "MCP" | "SERVICE" | "FIRST_PARTY_ECOSYSTEM";
  name: string;
  description?: string;
  service?: string;
  baseUrl?: string;
  supportedAuth?: { type: string }[];
  status?: string;
  branding?: {
    category?: string;
    developer?: string;
    website?: string;
    privacy_policy?: string;
    terms_of_service?: string;
  };
  developerType?: string;
}

function buildMcp(): Integration[] {
  const claude = readJson<{ servers: ClaudeServer[] }>(join(SOURCES, "claude.json"));
  const openai = readJson<{ connectors: OpenAIConnector[] }>(join(SOURCES, "openai.json"));

  // Index by canonical URL (host+path) and by normalized name as fallback.
  const byUrl = new Map<string, Integration>();
  const byName = new Map<string, Integration>();
  const all: Integration[] = [];

  const insert = (rec: Integration, url: string | undefined) => {
    all.push(rec);
    if (url) byUrl.set(url, rec);
    const nameKey = normName(rec.name);
    if (!byName.has(nameKey)) byName.set(nameKey, rec);
  };

  for (const s of claude.servers) {
    const url = canonUrl(s.remote?.url);
    const nameKey = normName(s.name);
    const existing = (url && byUrl.get(url)) || byName.get(nameKey);
    if (existing && existing.feeds.includes("claude")) {
      // Intra-feed collision (e.g. two listings of the same server). Skip the dupe;
      // first wins. The full record is preserved in raw.claude on the original.
      continue;
    }
    const slug = s.slug || slugify(s.name);
    const rec: Integration = {
      id: `mcp/${slug}`,
      kind: "mcp",
      slug,
      name: s.name,
      description: s.description || s.one_liner || "",
      url: s.documentation || s.directory_url,
      icon: s.icon_url,
      categories: s.categories ?? [],
      feeds: ["claude"],
      popularity: s.popularity_score,
      mcp: {
        remoteUrl: s.remote?.url,
        transport: s.remote?.transport,
        isAuthless: s.remote?.is_authless,
        toolNames: s.tool_names,
        worksWith: s.works_with,
      },
      raw: { claude: s },
    };
    insert(rec, url);
  }

  for (const c of openai.connectors) {
    if (c.connectorType !== "MCP") continue; // only MCP for now; SERVICE handled separately if we want
    const url = canonUrl(c.baseUrl);
    const nameKey = normName(c.name);
    const existing = (url && byUrl.get(url)) || byName.get(nameKey);

    if (existing) {
      // Merge into existing (claude record wins for descriptive fields by default).
      existing.feeds.push("openai");
      existing.raw.openai = c;
      // Fill in any missing fields from openai data.
      if (!existing.description && c.description) existing.description = c.description;
      if (!existing.mcp?.remoteUrl && c.baseUrl) {
        existing.mcp = { ...(existing.mcp ?? {}), remoteUrl: c.baseUrl };
      }
      if (c.supportedAuth?.length) {
        existing.mcp = {
          ...(existing.mcp ?? {}),
          authTypes: Array.from(
            new Set([...(existing.mcp?.authTypes ?? []), ...c.supportedAuth.map((a) => a.type)]),
          ),
        };
      }
      continue;
    }

    const slug = slugify(c.name);
    const rec: Integration = {
      id: `mcp/${slug}`,
      kind: "mcp",
      slug,
      name: c.name,
      description: c.description ?? "",
      url: c.branding?.website,
      categories: c.branding?.category ? [c.branding.category] : [],
      feeds: ["openai"],
      mcp: {
        remoteUrl: c.baseUrl,
        authTypes: c.supportedAuth?.map((a) => a.type),
      },
      raw: { openai: c },
    };
    insert(rec, url);
  }

  return dedupeSlugs(all);
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI: api-guru-openapi.json
// ─────────────────────────────────────────────────────────────────────────────

interface ApiGuruSpec {
  provider: string;
  versionKey: string;
  title: string;
  description?: string;
  updated?: string;
  added?: string;
  openapiVer: string;
  origin?: string;
  link?: string;
  swaggerUrl?: string;
  swaggerYamlUrl?: string;
  categories?: string[];
  service?: string | null;
  providerName?: string;
  raw?: { info?: { "x-logo"?: { url?: string } } };
}

function isHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isPlausibleSpecUrl(url: string | undefined): url is string {
  if (!isHttpUrl(url)) return false;
  const path = new URL(url).pathname;
  return /\.(json|ya?ml)$/i.test(path) || /openapi|swagger/i.test(path);
}

function buildOpenapi(): Integration[] {
  const data = readJson<{ specs: ApiGuruSpec[] }>(join(SOURCES, "api-guru-openapi.json"));
  // Hand-curated specs (sources/openapi-manual.json) — kept separate so they
  // survive an apis.guru refetch; they override an apis.guru entry on key match.
  const manualPath = join(SOURCES, "openapi-manual.json");
  const manual = existsSync(manualPath) ? readJson<{ specs: ApiGuruSpec[] }>(manualPath).specs : [];
  const keyOf = (s: ApiGuruSpec) => (s.service ? `${s.provider}:${s.service}` : s.provider);
  const manualKeys = new Set(manual.map(keyOf));

  // One record per provider+service (collapse versions, keep newest).
  const byKey = new Map<string, ApiGuruSpec>();
  for (const s of data.specs) {
    const key = keyOf(s);
    if (manualKeys.has(key)) continue; // a manual entry owns this key
    const prev = byKey.get(key);
    if (!prev || (s.updated && prev.updated && s.updated > prev.updated)) {
      byKey.set(key, s);
    }
  }
  for (const s of manual) byKey.set(keyOf(s), s);

  const recs: Integration[] = [];
  for (const [key, s] of byKey) {
    const slug = slugify(key);
    const feed: Feed = manualKeys.has(key) ? "override" : "apis-guru";
    // Always link the apis.guru mirror: origin URLs are provider-reported and
    // frequently dead or redirecting to an HTML portal (even spec-looking ones
    // like walmart's /v1/swaggerProxy). Origin survives as the docs link when
    // it isn't itself a spec document.
    const specUrl = s.swaggerUrl ?? s.link ?? (isPlausibleSpecUrl(s.origin) ? s.origin : undefined);
    const docsUrl = !isPlausibleSpecUrl(s.origin) && isHttpUrl(s.origin) ? s.origin : undefined;
    recs.push({
      id: `openapi/${slug}`,
      kind: "openapi",
      slug,
      name: s.service ? `${s.providerName ?? s.provider} – ${s.service}` : (s.title || s.provider),
      description: s.description ?? "",
      url: undefined, // s.link is the apis.guru mirror; the apex domain is the home
      icon: undefined, // derived from the apex domain in buildIndex
      categories: s.categories ?? [],
      feeds: [feed],
      openapi: {
        provider: s.provider,
        service: s.service ?? undefined,
        version: s.versionKey,
        specUrl,
        docsUrl,
        openapiVer: s.openapiVer,
        updated: s.updated,
        added: s.added,
      },
      raw: { [feed]: s },
    });
  }
  return dedupeSlugs(recs);
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL: graphql.json
// ─────────────────────────────────────────────────────────────────────────────

interface GraphqlEntry {
  title: string;
  description?: string;
  url: string;
  docs?: { description?: string; url: string }[];
  logo?: { url?: string };
  security?: unknown[];
  hasSecurity?: boolean;
}

function buildGraphql(): Integration[] {
  const data = readJson<GraphqlEntry[]>(join(SOURCES, "graphql.json"));
  const recs: Integration[] = data.map((g) => {
    const slug = slugify(g.title);
    return {
      id: `graphql/${slug}`,
      kind: "graphql" as const,
      slug,
      name: g.title,
      description: g.description ?? "",
      url: g.url,
      icon: g.logo?.url,
      categories: [],
      feeds: ["graphql-apis" as Feed],
      graphql: {
        endpoint: g.url,
        hasSecurity: !!g.hasSecurity,
        docs: g.docs ?? [],
      },
      raw: { "graphql-apis": g },
    };
  });
  return dedupeSlugs(recs);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI: sources/cli.json (demo seed) -> records grouped by their service domain
// ─────────────────────────────────────────────────────────────────────────────

interface CliSeed {
  name: string;
  domain: string;
  install: string;
  docs?: string;
  repo?: string;
  description?: string;
}

function buildCli(): Integration[] {
  const path = join(SOURCES, "cli.json");
  if (!existsSync(path)) return [];
  const data = readJson<{ clis: CliSeed[] }>(path);
  const recs: Integration[] = (data.clis ?? []).map((c) => {
    const slug = slugify(c.name);
    return {
      id: `cli/${slug}`,
      kind: "cli" as const,
      slug,
      name: c.name,
      description: c.description ?? "",
      url: c.docs,
      icon: faviconUrl(c.domain) ?? undefined,
      categories: [],
      feeds: ["cli-seed" as Feed],
      cli: { install: c.install, domain: c.domain, docs: c.docs, repo: c.repo },
      raw: { "cli-seed": c } as never,
    };
  });
  return dedupeSlugs(recs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovered: compact overnight batch results -> one record per domain+format
// ─────────────────────────────────────────────────────────────────────────────

type DiscoveredSurfaceType = "http" | "graphql" | "mcp" | "cli";

interface DiscoveredSurface {
  slug: string;
  name: string;
  type: DiscoveredSurfaceType;
  url?: string;
  spec?: string;
  command?: string;
  authStatus: "none" | "required" | "unknown";
}

interface DiscoveredDomain {
  domain: string;
  description?: string;
  summary?: string;
  surfaces?: DiscoveredSurface[];
}

const DISCOVERED_KIND_PRIORITY: Kind[] = ["mcp", "openapi", "graphql", "cli"];
// Railway's hand-maintained CLI source moved to railway.com. Keep the old
// crawler row deduped against that source so normalization does not add records.
const DISCOVERED_ALIAS_DEDUPE = new Set(aliasesOf("railway.com"));

const discoveredKind = (type: DiscoveredSurfaceType): Kind => (type === "http" ? "openapi" : type);

function buildDiscovered(knownDomains: Set<string>): Integration[] {
  const path = join(SOURCES, "discovered.json");
  if (!existsSync(path)) return [];
  const data = readJson<{ domains: DiscoveredDomain[] }>(path);
  const recs: Integration[] = [];

  for (const d of data.domains ?? []) {
    const domain = d.domain.trim().toLowerCase();
    if (!domain || knownDomains.has(domain)) continue;
    if (DISCOVERED_ALIAS_DEDUPE.has(domain) && knownDomains.has(canonicalDomain(domain))) continue;
    const surfaces = d.surfaces ?? [];
    const byKind = new Map<Kind, DiscoveredSurface>();
    for (const surface of surfaces) {
      // A client SDK/library mis-typed as `cli` is not a CLI surface — skip it.
      if (isSdkNotCli(surface)) continue;
      const kind = discoveredKind(surface.type);
      if (!byKind.has(kind)) byKind.set(kind, surface);
    }
    const kinds = DISCOVERED_KIND_PRIORITY.filter((kind) => byKind.has(kind));
    if (kinds.length === 0) continue;

    const domainSlug = slugify(domain);
    const description = (d.description || d.summary || "").replace(/\s+/g, " ").trim().slice(0, 240);
    kinds.forEach((kind, i) => {
      const surface = byKind.get(kind)!;
      const slug = i === 0 ? domainSlug : `${domainSlug}-${kind}`;
      const rec: Integration = {
        id: `discovered/${domainSlug}-${kind}`,
        kind,
        slug,
        name: domain,
        description,
        url: undefined,
        icon: faviconUrl(domain) ?? undefined,
        categories: [],
        feeds: ["discovered"],
        raw: { discovered: { domain, surface } },
      };
      if (kind === "mcp") {
        rec.mcp = { remoteUrl: surface.url };
      } else if (kind === "openapi") {
        rec.openapi = {
          provider: domain,
          version: "discovered",
          specUrl: surface.spec,
          docsUrl: surface.url,
          openapiVer: "",
        };
      } else if (kind === "graphql") {
        rec.graphql = {
          endpoint: surface.url ?? "",
          hasSecurity: surface.authStatus === "required",
          docs: [],
        };
      } else {
        rec.cli = {
          install: surface.command ?? "",
          domain,
        };
      }
      recs.push(rec);
    });
  }

  return dedupeSlugs(recs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overrides: deep-merged onto records by id
// ─────────────────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (!isObject(base) || !isObject(patch)) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v as never) : v;
  }
  return out as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Favicons: output/favicons.json from validate-favicons.ts. When an icon URL
// is known-broken we fall back to a domain-based service URL derived via
// tldts. Untested icons are kept as-is.
// ─────────────────────────────────────────────────────────────────────────────

interface IconStatus {
  ok: boolean;
  status?: number;
  error?: string;
}

const faviconCache: Record<string, IconStatus> = (() => {
  const p = join(OUTPUT, "favicons.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, IconStatus>;
  } catch {
    return {};
  }
})();

function fallbackDomain(item: Integration): string | undefined {
  // For each kind, pick the URL that best identifies the vendor's domain.
  let candidate: string | undefined;
  if (item.kind === "openapi") {
    // apis.guru's `provider` field is already an eTLD+1 (e.g. "1password.com").
    candidate = item.openapi?.provider;
    if (candidate && !/^https?:\/\//.test(candidate)) candidate = `https://${candidate}`;
  } else if (item.kind === "mcp") {
    candidate = item.mcp?.remoteUrl ?? item.url;
  } else if (item.kind === "graphql") {
    candidate = item.graphql?.endpoint ?? item.url;
  }
  candidate ??= item.url;
  if (!candidate) return undefined;
  const domain = getDomain(candidate);
  return domain ?? undefined;
}

function applyFavicons(recs: Integration[]): Integration[] {
  return recs.map((r) => {
    if (r.icon) {
      const status = faviconCache[r.icon];
      if (!status) return r; // not yet validated; keep as-is
      if (status.ok) return r;
    }
    const domain = fallbackDomain(r);
    if (!domain) return { ...r, icon: undefined };
    return {
      ...r,
      icon: faviconUrl(domain) ?? undefined,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool cache: output/tools/<kind>/<slug>.json from extract-tools.ts
// ─────────────────────────────────────────────────────────────────────────────

interface ToolsCache {
  status: "ok" | "error" | "skipped";
  reason?: string;
  tools: ExtractedTool[];
}

function applyToolsCache(kind: Kind, recs: Integration[]): Integration[] {
  const dir = join(OUTPUT, "tools", kind);
  if (!existsSync(dir)) return recs;
  return recs.map((r) => {
    // Don't clobber tools an override already set explicitly.
    if (r.tools && r.tools.length > 0) return r;
    const p = join(dir, `${r.slug}.json`);
    if (!existsSync(p)) return r;
    const cache = JSON.parse(readFileSync(p, "utf8")) as ToolsCache;
    return {
      ...r,
      tools: cache.tools,
      toolsStatus: cache.status,
      toolsReason: cache.reason,
    };
  });
}

function applyOverrides(kind: Kind, recs: Integration[]): Integration[] {
  const dir = join(OVERRIDES, kind);
  if (!existsSync(dir)) return recs;
  const patches = new Map<string, Partial<Integration>>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const slug = file.replace(/\.json$/, "");
    patches.set(slug, readJson<Partial<Integration>>(join(dir, file)));
  }
  // Patch matching records.
  const updated = recs.map((r) =>
    patches.has(r.slug) ? deepMerge(r, patches.get(r.slug)!) : r,
  );
  // Add new records for overrides whose slug doesn't match any existing record.
  // The override file must supply at least name + description.
  const existingSlugs = new Set(recs.map((r) => r.slug));
  for (const [slug, patch] of patches) {
    if (existingSlugs.has(slug)) continue;
    if (!patch.name) {
      console.warn(`overrides/${kind}/${slug}.json: skipping addition (no "name")`);
      continue;
    }
    updated.push({
      id: `${kind}/${slug}`,
      kind,
      slug,
      name: patch.name,
      description: patch.description ?? "",
      categories: [],
      feeds: ["override" as Feed],
      raw: {},
      ...patch,
    } as Integration);
  }
  if (kind !== "openapi") return updated;
  return updated.map((r) => {
    const swaggerUrl = (r.openapi as (typeof r.openapi & { swaggerUrl?: string }) | undefined)?.swaggerUrl;
    if (!r.openapi || r.openapi.specUrl || !swaggerUrl) return r;
    return { ...r, openapi: { ...r.openapi, specUrl: swaggerUrl } };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Slug dedup within a kind
// ─────────────────────────────────────────────────────────────────────────────

function dedupeSlugs(recs: Integration[]): Integration[] {
  const seen = new Map<string, number>();
  for (const r of recs) {
    const n = seen.get(r.slug) ?? 0;
    if (n > 0) {
      r.slug = `${r.slug}-${n + 1}`;
      r.id = `${r.kind}/${r.slug}`;
    }
    seen.set(r.slug.replace(/-\d+$/, ""), n + 1);
  }
  return recs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Index: slim record for search
// ─────────────────────────────────────────────────────────────────────────────

const KIND_ORDER: Kind[] = ["mcp", "openapi", "graphql", "cli"];

// The registrable domain a record belongs to — the grouping key for the
// domain-grouped homepage. OpenAPI carries an eTLD+1 provider already; for MCP
// and GraphQL we derive it from the endpoint (mcp.notion.com → notion.com).
// Well-known consumer products that live as sub-specs of a platform domain
// (Google Discovery, etc.). Without this they group under the platform
// (googleapis.com) and the brand disappears. Keyed by the full apis.guru
// provider string "<platform>:<service>".
const DOMAIN_REMAP: Record<string, string> = {
  "googleapis.com:gmail": "gmail.com",
  "googleapis.com:calendar": "calendar.google.com",
  "googleapis.com:drive": "drive.google.com",
  "googleapis.com:docs": "docs.google.com",
  "googleapis.com:sheets": "sheets.google.com",
  "googleapis.com:slides": "slides.google.com",
  "googleapis.com:people": "contacts.google.com",
  "googleapis.com:tasks": "tasks.google.com",
  "googleapis.com:youtube": "youtube.com",
  "googleapis.com:chat": "chat.google.com",
};

function rawRecordDomain(r: Integration): string {
  let url: string | undefined;
  if (r.kind === "openapi") {
    const provider = (r.openapi?.provider ?? "").trim();
    if (DOMAIN_REMAP[provider]) return DOMAIN_REMAP[provider];
    const d = provider.split(":")[0].toLowerCase();
    if (d) return d;
    url = r.openapi?.specUrl ?? r.url;
  } else if (r.kind === "mcp") {
    url = r.mcp?.remoteUrl ?? r.url;
  } else if (r.kind === "cli") {
    return r.cli?.domain ?? "";
  } else {
    url = r.graphql?.endpoint ?? r.url;
  }
  const discoveredDomain = (r.raw.discovered as { domain?: string } | undefined)?.domain;
  if (discoveredDomain) return discoveredDomain;
  return (url ? getDomain(url) : null) ?? (r.url ? getDomain(r.url) ?? "" : "");
}

function recordDomain(r: Integration): string {
  return canonicalDomain(rawRecordDomain(r));
}

function addTargetDomain(targets: Set<string>, url: unknown): void {
  if (typeof url !== "string" || !url.trim()) return;
  const domain = getDomain(url);
  if (domain) targets.add(canonicalDomain(domain));
}

function addOpenapiTargetUrls(targets: Set<string>, value: unknown): void {
  if (!isObject(value)) return;

  const servers = value.servers;
  if (Array.isArray(servers)) {
    for (const server of servers) {
      addTargetDomain(targets, typeof server === "string" ? server : isObject(server) ? server.url : undefined);
    }
  }

  addTargetDomain(targets, value.baseUrl);
  addTargetDomain(targets, value.baseURL);
  addTargetDomain(targets, value.serverUrl);
  addTargetDomain(targets, value.serverURL);
}

function outboundTargetDomains(r: Integration): string[] {
  const targets = new Set<string>();

  addTargetDomain(targets, r.mcp?.remoteUrl);
  addTargetDomain(targets, r.graphql?.endpoint);

  const discovered = r.raw.discovered as { surface?: { url?: unknown }; surfaces?: { url?: unknown }[] } | undefined;
  addTargetDomain(targets, discovered?.surface?.url);
  if (Array.isArray(discovered?.surfaces)) {
    for (const surface of discovered.surfaces) addTargetDomain(targets, surface.url);
  }

  if (r.kind === "openapi") {
    addOpenapiTargetUrls(targets, r.openapi);
    for (const raw of Object.values(r.raw)) {
      addOpenapiTargetUrls(targets, raw);
      if (isObject(raw)) addOpenapiTargetUrls(targets, raw.raw);
    }
  }

  return [...targets].sort();
}

function printDomainMismatchWarnings(all: Integration[]): void {
  const warnings: string[] = [];
  for (const r of all) {
    const assigned = recordDomain(r);
    if (!assigned) continue;
    const targets = outboundTargetDomains(r).filter((target) => target !== assigned);
    if (targets.length === 0) continue;
    warnings.push(`domain-mismatch: ${r.id} assigned=${assigned} targets=${targets.join(",")}`);
  }

  if (warnings.length === 0) return;
  console.warn(`domain-mismatch warnings: ${warnings.length}`);
  for (const warning of warnings.slice(0, 50)) console.warn(warning);
  if (warnings.length > 50) console.warn(`domain-mismatch warnings truncated: showing 50 of ${warnings.length}`);
}

function buildIndex(all: Integration[]) {
  return all.map((r) => {
    const domain = recordDomain(r);
    const remapped = r.kind === "openapi" && DOMAIN_REMAP[(r.openapi?.provider ?? "").trim()];
    return {
      id: r.id,
      kind: r.kind,
      slug: r.slug,
      // Strip the platform prefix from remapped names: "googleapis.com – gmail" → "gmail".
      name: remapped ? r.name.replace(/^.*?[–-]\s*/, "") : r.name,
      description: r.description.slice(0, 240),
      url: r.url,
      // Icon is the provider's own apex-domain favicon — never a third-party host,
      // and never a LAN address (.local/private hosts return null).
      icon: faviconUrl(domain) ?? undefined,
      domain,
      categories: r.categories,
      feeds: r.feeds,
      popularity: r.popularity,
      devtool: DEVTOOL_DOMAINS.has(domain) || undefined,
    };
  });
}

type IndexEntry = ReturnType<typeof buildIndex>[number];

interface SearchIndexEntry {
  domain: string;
  description: string;
  kinds: Kind[];
  devtool: boolean;
  popularity: number;
  total: number;
}

function buildSearchIndex(index: IndexEntry[]): SearchIndexEntry[] {
  const map = new Map<string, { domain: string; description: string; kinds: Set<Kind>; devtool: boolean; popularity: number; total: number }>();
  for (const r of index) {
    const domain = r.domain || r.slug;
    if (!domain) continue;
    if (isJunkDomain(domain)) continue;
    let group = map.get(domain);
    if (!group) {
      group = { domain, description: "", kinds: new Set(), devtool: false, popularity: 0, total: 0 };
      map.set(domain, group);
    }
    group.total++;
    group.kinds.add(r.kind);
    group.popularity = Math.max(group.popularity, r.popularity ?? 0);
    group.devtool ||= r.devtool === true;
    if (!group.description && r.description) group.description = r.description.replace(/\s+/g, " ").slice(0, 110);
  }

  return [...map.values()]
    .map((group) => ({
      domain: group.domain,
      description: group.description,
      kinds: KIND_ORDER.filter((kind) => group.kinds.has(kind)),
      devtool: group.devtool,
      popularity: group.popularity,
      total: group.total,
    }))
    .sort(
      (a, b) => Number(b.devtool) - Number(a.devtool) || b.popularity - a.popularity || b.total - a.total || a.domain.localeCompare(b.domain),
    );
}

interface CatalogSeedEntry {
  kind: Kind;
  name: string;
  feeds: Feed[];
  remoteUrl?: string;
  transport?: string;
  authTypes?: string[];
  specUrl?: string;
  docsUrl?: string;
  endpoint?: string;
  docs?: string;
  command?: string;
  install?: string;
  repo?: string;
}

function catalogSeedEntry(r: Integration): { domain: string; entry: CatalogSeedEntry } | null {
  if (r.feeds.includes("discovered")) return null;

  const domain = recordDomain(r);
  if (!domain) return null;

  const base = { kind: r.kind, name: r.name, feeds: r.feeds };
  if (r.kind === "mcp") {
    if (!r.mcp?.remoteUrl) return null;
    return { domain, entry: { ...base, remoteUrl: r.mcp.remoteUrl, transport: r.mcp.transport, authTypes: r.mcp.authTypes } };
  }
  if (r.kind === "openapi") {
    if (!r.openapi?.specUrl) return null;
    return { domain, entry: { ...base, specUrl: r.openapi.specUrl, docsUrl: r.openapi.docsUrl } };
  }
  if (r.kind === "graphql") {
    if (!r.graphql?.endpoint) return null;
    return { domain, entry: { ...base, endpoint: r.graphql.endpoint, docs: r.graphql.docs[0]?.url } };
  }
  if (r.kind === "cli") {
    if (!r.cli || !r.slug) return null;
    return { domain, entry: { ...base, command: r.slug, install: r.cli.install, docs: r.cli.docs, repo: r.cli.repo } };
  }
  return null;
}

function buildCatalogSeedData(all: Integration[]): Record<string, CatalogSeedEntry[]> {
  const out: Record<string, CatalogSeedEntry[]> = {};
  for (const r of all) {
    const seeded = catalogSeedEntry(r);
    if (!seeded) continue;
    (out[seeded.domain] ??= []).push(seeded.entry);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

// Hosts whose MCP endpoints are gated behind a single product (not a public,
// directly-reachable server). Anthropic-hosted connectors only work inside
// Claude, so they aren't publicly accessible.
const GATED_HOST = /(^|\.)claude\.com$|(^|\.)anthropic\.com$/;

// A record is "publicly accessible" if anyone can reach or install it without
// going through a specific vendor's product. For MCP that means a public remote
// endpoint on a non-gated host, or a public install command; directory-only
// listings with neither are dropped. OpenAPI/GraphQL come from public-spec
// registries, so they qualify unless the endpoint is explicitly local.
function isPublic(r: Integration): boolean {
  if (r.kind === "mcp") {
    const url = r.mcp?.remoteUrl;
    if (url) {
      try {
        return !GATED_HOST.test(new URL(url).hostname);
      } catch {
        /* malformed URL — fall through to install check */
      }
    }
    return Boolean(r.mcp?.install);
  }
  if (r.kind === "graphql") {
    const ep = r.graphql?.endpoint ?? "";
    return !/localhost|127\.0\.0\.1|\.local\b/.test(ep);
  }
  if (r.kind === "cli") return Boolean(r.cli?.install); // publicly installable
  return true; // openapi: apis.guru lists public API specs
}

function main() {
  // Order: build feed records → apply overrides (may add new records) → fill
  // tools from cache → swap broken icons for domain-based fallbacks → keep only
  // publicly-accessible records.
  const baseMcp = applyFavicons(applyToolsCache("mcp", applyOverrides("mcp", buildMcp()))).filter(isPublic);
  const baseOpenapi = applyFavicons(applyToolsCache("openapi", applyOverrides("openapi", buildOpenapi()))).filter(isPublic);
  const baseGraphql = applyFavicons(applyToolsCache("graphql", applyOverrides("graphql", buildGraphql()))).filter(isPublic);
  const baseCli = buildCli().filter(isPublic);

  const knownDomains = new Set(
    [...baseMcp, ...baseOpenapi, ...baseGraphql, ...baseCli]
      .flatMap((r) => [rawRecordDomain(r), recordDomain(r)])
      .filter(Boolean),
  );
  const discovered = buildDiscovered(knownDomains).filter(isPublic);
  const mcp = [...baseMcp, ...discovered.filter((r) => r.kind === "mcp")];
  const openapi = [...baseOpenapi, ...discovered.filter((r) => r.kind === "openapi")];
  const graphql = [...baseGraphql, ...discovered.filter((r) => r.kind === "graphql")];
  const cli = [...baseCli, ...discovered.filter((r) => r.kind === "cli")];

  writeFileSync(join(OUTPUT, "mcp.json"), JSON.stringify(mcp, null, 2));
  writeFileSync(join(OUTPUT, "openapi.json"), JSON.stringify(openapi, null, 2));
  writeFileSync(join(OUTPUT, "graphql.json"), JSON.stringify(graphql, null, 2));
  writeFileSync(join(OUTPUT, "cli.json"), JSON.stringify(cli, null, 2));

  const all = [...mcp, ...openapi, ...graphql, ...cli];
  const index = buildIndex(all);
  writeFileSync(join(OUTPUT, "index.json"), JSON.stringify(index));
  writeFileSync(join(OUTPUT, "catalog-seeds.json"), JSON.stringify(buildCatalogSeedData(all)));
  writeFileSync(join(OUTPUT, "search-index.json"), JSON.stringify(buildSearchIndex(index)));

  const mergedMcp = mcp.filter((r) => r.feeds.length > 1).length;
  const withTools = (rs: Integration[]) =>
    rs.filter((r) => r.toolsStatus === "ok" && (r.tools?.length ?? 0) > 0).length;
  console.log(
    `mcp:     ${mcp.length.toString().padStart(5)}  (${mergedMcp} merged, ${withTools(mcp)} with tools)`,
  );
  console.log(`openapi: ${openapi.length.toString().padStart(5)}  (${withTools(openapi)} with tools)`);
  console.log(`graphql: ${graphql.length.toString().padStart(5)}  (${withTools(graphql)} with tools)`);
  console.log(`cli:     ${cli.length.toString().padStart(5)}`);
  console.log(`discovered: ${discovered.length.toString().padStart(5)}`);
  console.log(`total:   ${all.length.toString().padStart(5)}`);

  const validatedIcons = Object.keys(faviconCache).length;
  if (validatedIcons === 0) {
    console.log(`favicons: no validation cache yet — run \`bun run validate-favicons\``);
  } else {
    const fb = all.filter((r) => r.icon?.endsWith("/favicon.ico")).length;
    console.log(`favicons: ${validatedIcons} URLs validated, ${fb} records using domain fallback`);
  }

  printDomainMismatchWarnings(all);
}

main();
