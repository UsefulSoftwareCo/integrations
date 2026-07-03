import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSpecUrl } from "../../src/lib/spec-validate.ts";
import { getFlag, getNumberFlag, hasFlag, listJsonFiles, mapLimit, parseArgs, ROOT, usage } from "./shared.ts";

const HELP = `
Usage: bun scripts/batch/enrich-specs.ts [flags]

Flags:
  --dir dir          Results dir (default: scripts/batch/results-full)
  --concurrency N   Files to process concurrently (default: 16)
  --dry-run         Print changes without rewriting files
  --only a.com,b.com
  --help            Show this help
`;

const SPEC_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/openapi",
  "/swagger.json",
  "/api/openapi.json",
  "/v1/openapi.json",
  "/v1/openapi",
  "/api-docs",
  "/api/schema/",
  "/.well-known/openapi.json",
] as const;

const MAX_PROBES_PER_SURFACE = 12;
export const OAUTH_PLUMBING_RE = /\/oauth2?\/(authorize|token|device|register)|\/(authorize|token)\/?$/i;

type JsonObject = Record<string, unknown>;
type Surface = JsonObject & {
  type?: unknown;
  name?: unknown;
  url?: unknown;
  docs?: unknown;
  spec?: unknown;
  specAlternates?: unknown;
};
type StoredDiscovery = JsonObject & {
  result?: JsonObject & {
    domain?: unknown;
    surfaces?: unknown;
  };
};
type ProbeResult = { ok: true; kind: "openapi-json" | "openapi-yaml" } | { ok: false };
type OriginCache = Map<string, Promise<ProbeResult>>;

export function isOAuthPlumbingUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return OAUTH_PLUMBING_RE.test(new URL(value).pathname);
  } catch {
    return OAUTH_PLUMBING_RE.test(value);
  }
}

export function candidateSpecUrls(surfaceUrl: string): string[] {
  const url = new URL(surfaceUrl);
  const out: string[] = [];
  const add = (value: string): void => {
    if (!out.includes(value)) out.push(value);
  };
  const origin = url.origin;
  const path = normalizePath(url.pathname);
  const apiHost = isApiLookingHost(url.hostname);
  const versionBase = versionBasePath(path);
  for (const specPath of SPEC_PATHS) add(`${origin}${joinUrlPath("", specPath)}`);
  if (versionBase) {
    add(`${origin}${joinUrlPath(versionBase, "/openapi")}`);
    add(`${origin}${joinUrlPath(versionBase, "/openapi.json")}`);
    for (const specPath of SPEC_PATHS) add(`${origin}${joinUrlPath(versionBase, specPath)}`);
  }
  if (apiHost && isBarePath(path)) {
    const base = versionBase ?? "";
    add(`${origin}${joinUrlPath(base, "/openapi")}`);
    add(`${origin}${joinUrlPath(base, "/openapi.json")}`);
  }
  return out.slice(0, MAX_PROBES_PER_SURFACE);
}

function candidateSource(surface: Surface): string | undefined {
  if (typeof surface.url === "string" && isHttpUrl(surface.url)) return surface.url;
  if (typeof surface.docs === "string" && isHttpUrl(surface.docs)) {
    const docs = new URL(surface.docs);
    if (isApiLookingHost(docs.hostname)) return surface.docs;
  }
  return undefined;
}

function normalizePath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean || "/";
}

function versionBasePath(path: string): string | undefined {
  const match = /^\/v\d+(?:\/|$)/i.exec(path);
  return match ? match[0]!.replace(/\/$/, "") : undefined;
}

function isBarePath(path: string): boolean {
  return path === "/";
}

function joinUrlPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function isApiLookingHost(hostname: string): boolean {
  return hostname.split(".").some((label) => /api/i.test(label));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasSpec(surface: Surface): boolean {
  return typeof surface.spec === "string" && surface.spec.trim().length > 0;
}

function specFamily(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\.(json|ya?ml)$/i, "");
  return url.toString().replace(/\/$/, "");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

async function probeSpec(url: string, cache: OriginCache): Promise<ProbeResult> {
  const cached = cache.get(url);
  if (cached) return cached;
  const promise = validateSpecUrl(url, "http").then((result): ProbeResult => {
    if (result.ok && (result.kind === "openapi-json" || result.kind === "openapi-yaml")) return { ok: true, kind: result.kind };
    return { ok: false };
  }).catch((): ProbeResult => ({ ok: false }));
  cache.set(url, promise);
  return promise;
}

async function enrichSurface(surface: Surface, cache: OriginCache): Promise<boolean> {
  if (surface.type !== "http" || hasSpec(surface)) return false;
  const source = candidateSource(surface);
  if (!source) return false;

  let primary: string | undefined;
  const validated: string[] = [];
  for (const candidate of candidateSpecUrls(source)) {
    const result = await probeSpec(candidate, cache);
    if (!result.ok) continue;
    validated.push(candidate);
    primary ??= candidate;
  }
  if (!primary) return false;

  surface.spec = primary;
  const primaryFamily = specFamily(primary);
  const alternates = [
    ...stringArray(surface.specAlternates),
    ...validated.filter((candidate) => candidate !== primary && specFamily(candidate) === primaryFamily),
  ];
  const seen = new Set<string>();
  const uniqueAlternates = alternates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueAlternates.length) surface.specAlternates = uniqueAlternates;
  else delete surface.specAlternates;
  return true;
}

function surfaceName(surface: Surface): string {
  return typeof surface.name === "string" && surface.name.trim() ? surface.name : "(unnamed)";
}

async function processFile(path: string, dryRun: boolean): Promise<{ domain: string; changed: boolean; specsAdded: number; oauthDropped: number; logs: string[] }> {
  const before = readFileSync(path, "utf8");
  const row = JSON.parse(before) as StoredDiscovery;
  const result = row.result;
  const domain = typeof result?.domain === "string" ? result.domain : path.split("/").pop()!.replace(/\.json$/, "");
  const logs: string[] = [];
  let specsAdded = 0;
  let oauthDropped = 0;
  let changed = false;

  const surfaces = Array.isArray(result?.surfaces) ? result.surfaces as Surface[] : [];
  if (surfaces.length) {
    const kept: Surface[] = [];
    for (const surface of surfaces) {
      if (surface.type === "http" && isOAuthPlumbingUrl(surface.url)) {
        oauthDropped++;
        changed = true;
        logs.push(`drop-oauth ${domain} ${surfaceName(surface)}`);
        continue;
      }
      kept.push(surface);
    }
    if (oauthDropped && result) result.surfaces = kept;
  }

  const cache: OriginCache = new Map();
  const currentSurfaces = Array.isArray(result?.surfaces) ? result.surfaces as Surface[] : [];
  for (const surface of currentSurfaces) {
    if (await enrichSurface(surface, cache)) {
      specsAdded++;
      changed = true;
    }
  }

  if (changed && !dryRun) {
    const after = `${JSON.stringify(row, null, 2)}\n`;
    if (after !== before) writeFileSync(path, after);
  }
  if (specsAdded || oauthDropped) logs.push(`summary ${domain} +spec=${specsAdded} -oauth=${oauthDropped}`);
  return { domain, changed, specsAdded, oauthDropped, logs };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const dir = getFlag(args, "dir", join(ROOT, "scripts", "batch", "results-full"))!;
  const concurrency = getNumberFlag(args, "concurrency", 16);
  const dryRun = hasFlag(args, "dry-run");
  const only = new Set((getFlag(args, "only") ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  let files = listJsonFiles(dir);
  if (only.size) files = files.filter((file) => only.has(file.split("/").pop()!.replace(/\.json$/, "")));
  if (!files.length) throw new Error(`no result JSON files found in ${dir}${only.size ? ` for --only ${[...only].join(",")}` : ""}`);

  const rows = await mapLimit(files, concurrency, (file) => processFile(file, dryRun));
  for (const row of rows) for (const line of row.logs) console.log(line);

  const filesChanged = rows.filter((row) => row.changed).length;
  const specsAdded = rows.reduce((sum, row) => sum + row.specsAdded, 0);
  const oauthDropped = rows.reduce((sum, row) => sum + row.oauthDropped, 0);
  console.log(`final files_changed=${filesChanged} specs_added=${specsAdded} surfaces_dropped=${oauthDropped}${dryRun ? " dry_run=true" : ""}`);
}

if (import.meta.main) await main();
