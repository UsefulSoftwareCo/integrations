import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  aliasMapWith,
  DEFAULT_DOMAIN_CATALOG_DIR,
  listDomainCatalogFiles,
  mergeCatalogDomainRows,
  readDomainCatalogFile,
  stableJson,
  type CatalogDomain,
} from "./discovered-catalog.ts";
import { getFlag, getNumberFlag, hasFlag, mapLimit, parseArgs, registrable, ROOT, usage } from "./shared.ts";

const HELP = `
Usage: bun scripts/batch/redirect-canonical.ts [--all | --domain example.com] [flags]

Probes catalog domains for domain-wide cross-registrable redirects.

Flags:
  --all                 Probe every domains/<domain>/integrations.json row
  --domain domain       Probe one domain (can be passed more than once)
  --catalog-dir dir     Catalog tree to scan/apply against (default: domains)
  --apply               Write accepted aliases and merge catalog duplicates
  --apply-missing-targets  Also write aliases whose target has no catalog record
  --timeout-ms n        Per-request timeout (default: 8000)
  --concurrency n       Parallel probes for --all (default: 8)
  --verbose             Include no-alias decisions in text output
  --json                Emit JSON instead of text
  --help                Show this help
`;

const SECOND_PATH = "/.well-known/integrationsdotsh-redirect-probe";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CONCURRENCY = 8;
const MAX_REDIRECTS = 10;
const PARKED_TARGETS = new Set([
  "dan.com",
  "godaddy.com",
  "google.com",
  "hugedomains.com",
  "linktr.ee",
  "parkingcrew.net",
  "sedo.com",
]);
const SOURCE_EXEMPTIONS = new Set([
  "amazonaws.com",
  "amazonaws.com.cn",
]);

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type RedirectHop = {
  url: string;
  status: number;
  location?: string;
};

export type PathProbe = {
  path: string;
  startUrl: string;
  finalUrl: string;
  finalHostname: string | null;
  finalRegistrable: string | null;
  status: number;
  chain: RedirectHop[];
};

export type RedirectDecision =
  | {
      kind: "alias";
      source: string;
      target: string;
      reason: "domain-wide-redirect";
      root: PathProbe;
      second: PathProbe;
    }
  | {
      kind: "rejected";
      source: string;
      target?: string;
      reason:
        | "deep-unrelated-final-path"
        | "denylisted-target"
        | "intermediate-unrelated-hop"
        | "invalid-domain"
        | "root-second-target-mismatch"
        | "root-fetch-failed"
        | "source-exempted"
        | "second-fetch-failed";
      detail: string;
      root?: PathProbe;
      second?: PathProbe;
    }
  | {
      kind: "no_alias";
      source: string;
      reason: "same-registrable" | "no-registrable-target";
      detail: string;
      root: PathProbe;
    };

export type ProbeOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  secondPath?: string;
  trace?: boolean;
};

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

function probeUrl(domain: string, path: string): string {
  return `https://${domain}${path}`;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function targetIsParked(registrableDomain: string | null, hostname: string | null): boolean {
  if (!registrableDomain || PARKED_TARGETS.has(registrableDomain)) return Boolean(registrableDomain);
  return Boolean(hostname && [...PARKED_TARGETS].some((target) => hostname === target || hostname.endsWith(`.${target}`)));
}

function hasDeepPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path.length > 0;
  } catch {
    return false;
  }
}

function chainRegistrables(chain: RedirectHop[]): string[] {
  const out: string[] = [];
  for (const hop of chain) {
    for (const url of [hop.url, hop.location]) {
      if (!url) continue;
      const hostname = hostnameOf(url);
      const domain = hostname ? registrable(hostname) : null;
      if (domain) out.push(domain);
    }
  }
  return [...new Set(out)];
}

function unrelatedIntermediateRegistrables(probe: PathProbe, sourceRegistrable: string, target: string): string[] {
  const registrables = chainRegistrables(probe.chain);
  return registrables.filter((domain) => domain !== sourceRegistrable && domain !== target);
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function traceRedirects(fetchImpl: FetchLike, startUrl: string, timeoutMs: number): Promise<RedirectHop[]> {
  const chain: RedirectHop[] = [];
  let current = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetchWithTimeout(fetchImpl, current, { redirect: "manual" }, timeoutMs);
    const rawLocation = res.headers.get("location") ?? undefined;
    const location = rawLocation ? new URL(rawLocation, current).toString() : undefined;
    chain.push({ url: current, status: res.status, ...(location ? { location } : {}) });
    if (res.status < 300 || res.status >= 400 || !location) return chain;
    current = location;
  }
  return chain;
}

async function probePath(domain: string, path: string, options: Required<Pick<ProbeOptions, "timeoutMs" | "trace">> & { fetchImpl: FetchLike }): Promise<PathProbe> {
  const startUrl = probeUrl(domain, path);
  const res = await fetchWithTimeout(options.fetchImpl, startUrl, { redirect: "follow" }, options.timeoutMs);
  const finalUrl = res.url || startUrl;
  const finalHostname = hostnameOf(finalUrl);
  const chain = options.trace && finalUrl !== startUrl
    ? await traceRedirects(options.fetchImpl, startUrl, options.timeoutMs)
    : [{ url: startUrl, status: res.status }];
  return {
    path,
    startUrl,
    finalUrl,
    finalHostname,
    finalRegistrable: finalHostname ? registrable(finalHostname) : null,
    status: res.status,
    chain,
  };
}

export async function probeRedirectCanonical(domain: string, options: ProbeOptions = {}): Promise<RedirectDecision> {
  const source = normalizeDomain(domain);
  const sourceRegistrable = registrable(source);
  if (!sourceRegistrable) {
    return {
      kind: "rejected",
      source,
      reason: "invalid-domain",
      detail: "source domain does not have a valid registrable domain",
    };
  }

  if (SOURCE_EXEMPTIONS.has(source)) {
    return {
      kind: "rejected",
      source,
      reason: "source-exempted",
      detail: "source apex redirects, but subdomains under this registrable domain are independent service endpoints",
    };
  }

  const probeOptions = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    trace: options.trace ?? false,
  };

  let root: PathProbe;
  try {
    root = await probePath(source, "/", probeOptions);
  } catch (err) {
    return {
      kind: "rejected",
      source,
      reason: "root-fetch-failed",
      detail: (err as Error).message,
    };
  }

  if (!root.finalRegistrable) {
    return {
      kind: "no_alias",
      source,
      reason: "no-registrable-target",
      detail: `root landed on ${root.finalUrl}`,
      root,
    };
  }

  if (root.finalRegistrable === sourceRegistrable) {
    return {
      kind: "no_alias",
      source,
      reason: "same-registrable",
      detail: `${sourceRegistrable} stayed within the same registrable domain`,
      root,
    };
  }

  const target = root.finalRegistrable;
  if (targetIsParked(target, root.finalHostname)) {
    return {
      kind: "rejected",
      source,
      target,
      reason: "denylisted-target",
      detail: `root landed on parked/aggregator target ${root.finalHostname ?? target}`,
      root,
    };
  }

  const unrelatedIntermediates = unrelatedIntermediateRegistrables(root, sourceRegistrable, target);
  if (unrelatedIntermediates.length > 0) {
    return {
      kind: "rejected",
      source,
      target,
      reason: "intermediate-unrelated-hop",
      detail: `redirect chain passed through unrelated domain(s): ${unrelatedIntermediates.join(", ")}`,
      root,
    };
  }

  if (hasDeepPath(root.finalUrl)) {
    return {
      kind: "rejected",
      source,
      target,
      reason: "deep-unrelated-final-path",
      detail: `root landed on non-root path ${new URL(root.finalUrl).pathname}`,
      root,
    };
  }

  let second: PathProbe;
  try {
    second = await probePath(source, options.secondPath ?? SECOND_PATH, probeOptions);
  } catch (err) {
    return {
      kind: "rejected",
      source,
      target,
      reason: "second-fetch-failed",
      detail: (err as Error).message,
      root,
    };
  }

  if (second.finalRegistrable !== target) {
    return {
      kind: "rejected",
      source,
      target,
      reason: "root-second-target-mismatch",
      detail: `root landed on ${target}, second path landed on ${second.finalRegistrable ?? second.finalUrl}`,
      root,
      second,
    };
  }

  if (targetIsParked(second.finalRegistrable, second.finalHostname)) {
    return {
      kind: "rejected",
      source,
      target,
      reason: "denylisted-target",
      detail: `second path landed on parked/aggregator target ${second.finalHostname ?? target}`,
      root,
      second,
    };
  }

  return {
    kind: "alias",
    source,
    target,
    reason: "domain-wide-redirect",
    root,
    second,
  };
}

export async function probeRedirectCanonicals(domains: string[], options: ProbeOptions & { concurrency?: number } = {}): Promise<RedirectDecision[]> {
  const unique = [...new Set(domains.map(normalizeDomain).filter(Boolean))].sort();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  return mapLimit(unique, concurrency, (domain) => probeRedirectCanonical(domain, options));
}

function parseAliasEntries(source: string): Record<string, string> {
  const match = source.match(/export const DOMAIN_ALIASES: Record<string, string> = \{\n([\s\S]*?)\n\};/);
  if (!match) throw new Error("Could not find DOMAIN_ALIASES object");
  const entries: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = line.match(/^\s*"([^"]+)":\s*"([^"]+)",\s*$/);
    if (entry) entries[entry[1]!] = entry[2]!;
  }
  return entries;
}

export function upsertDomainAliasesFile(
  aliases: readonly { source: string; target: string }[],
  aliasPath = join(ROOT, "src", "lib", "domain-aliases.ts"),
): { changed: boolean; added: Array<{ source: string; target: string }> } {
  const before = readFileSync(aliasPath, "utf8");
  const current = parseAliasEntries(before);
  const next = { ...current };
  const added: Array<{ source: string; target: string }> = [];

  for (const alias of aliases) {
    const source = normalizeDomain(alias.source);
    let target = normalizeDomain(alias.target);
    while (next[target]) target = next[target]!;
    if (!source || !target || source === target) continue;
    if (next[source] === target) continue;
    next[source] = target;
    added.push({ source, target });
  }

  if (added.length === 0) return { changed: false, added };
  for (const [source, target] of Object.entries(next)) {
    if (!source || !target || source === target || next[target]) {
      throw new Error(`Invalid domain alias after update: ${source} -> ${target}`);
    }
  }

  const body = Object.entries(next)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, target]) => `  "${source}": "${target}",`)
    .join("\n");
  const after = before.replace(
    /export const DOMAIN_ALIASES: Record<string, string> = \{\n[\s\S]*?\n\};/,
    `export const DOMAIN_ALIASES: Record<string, string> = {\n${body}\n};`,
  );
  if (after !== before) writeFileSync(aliasPath, after);
  return { changed: after !== before, added };
}

function catalogPath(root: string, domain: string): string {
  return join(root, domain, "integrations.json");
}

function hasCatalogRecord(root: string, domain: string): boolean {
  return existsSync(catalogPath(root, domain));
}

function removeEmptyDomainDir(root: string, domain: string): void {
  const dir = join(root, domain);
  if (!existsSync(dir)) return;
  if (readdirSync(dir).length > 0) return;
  rmdirSync(dir);
}

function writeCatalogDomain(root: string, domain: CatalogDomain): boolean {
  const path = catalogPath(root, domain.domain);
  mkdirSync(join(path, ".."), { recursive: true });
  const next = stableJson(domain);
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (before === next) return false;
  writeFileSync(path, next);
  return true;
}

export function mergeAliasCatalogFiles(
  root: string,
  aliases: readonly { source: string; target: string }[],
): Array<{ source: string; target: string; action: "merged" | "moved" | "canonicalized" | "missing" }> {
  const results: Array<{ source: string; target: string; action: "merged" | "moved" | "canonicalized" | "missing" }> = [];
  for (const alias of aliases) {
    const source = normalizeDomain(alias.source);
    const target = normalizeDomain(aliasMapWith({ [source]: alias.target })[source] ?? alias.target);
    if (!source || !target || source === target) continue;
    const sourcePath = catalogPath(root, source);
    const targetPath = catalogPath(root, target);
    const sourceExists = existsSync(sourcePath);
    const targetExists = existsSync(targetPath);

    if (sourceExists && targetExists) {
      const canonical = readDomainCatalogFile(targetPath);
      const dropped = readDomainCatalogFile(sourcePath);
      writeCatalogDomain(root, mergeCatalogDomainRows(canonical, dropped, target));
      unlinkSync(sourcePath);
      removeEmptyDomainDir(root, source);
      results.push({ source, target, action: "merged" });
    } else if (sourceExists) {
      const moved = { ...readDomainCatalogFile(sourcePath), domain: target };
      writeCatalogDomain(root, moved);
      unlinkSync(sourcePath);
      removeEmptyDomainDir(root, source);
      results.push({ source, target, action: "moved" });
    } else if (targetExists) {
      const canonical = readDomainCatalogFile(targetPath);
      const changed = writeCatalogDomain(root, { ...canonical, domain: target });
      results.push({ source, target, action: changed ? "canonicalized" : "missing" });
    } else {
      results.push({ source, target, action: "missing" });
    }
  }
  return results;
}

function chainText(probe: PathProbe | undefined): string {
  if (!probe) return "";
  return probe.chain
    .map((hop) => `${hop.status} ${hop.url}${hop.location ? ` -> ${hop.location}` : ""}`)
    .join(" | ");
}

function formatDecision(decision: RedirectDecision, verbose: boolean): string | null {
  if (decision.kind === "alias") {
    return [
      `ALIAS ${decision.source} -> ${decision.target}`,
      `  / final: ${decision.root.finalUrl}`,
      `  / chain: ${chainText(decision.root)}`,
      `  ${decision.second.path} final: ${decision.second.finalUrl}`,
      `  ${decision.second.path} chain: ${chainText(decision.second)}`,
    ].join("\n");
  }
  if (decision.kind === "rejected") {
    return [
      `REJECT ${decision.source}${decision.target ? ` -> ${decision.target}` : ""} (${decision.reason})`,
      `  ${decision.detail}`,
      decision.root ? `  / final: ${decision.root.finalUrl}` : undefined,
      decision.second ? `  ${decision.second.path} final: ${decision.second.finalUrl}` : undefined,
    ].filter(Boolean).join("\n");
  }
  if (!verbose) return null;
  return `NO_ALIAS ${decision.source} (${decision.reason}) ${decision.detail}`;
}

function domainsFromCatalog(root: string): string[] {
  return listDomainCatalogFiles(root).map((path) => readDomainCatalogFile(path).domain);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);

  const catalogDir = resolve(ROOT, getFlag(args, "catalog-dir", DEFAULT_DOMAIN_CATALOG_DIR)!);
  const explicitDomains = args.flags.get("domain") ?? [];
  const domains = hasFlag(args, "all")
    ? domainsFromCatalog(catalogDir)
    : [...explicitDomains, ...args.positionals];
  if (domains.length === 0) usage(HELP);

  const decisions = await probeRedirectCanonicals(domains, {
    timeoutMs: getNumberFlag(args, "timeout-ms", DEFAULT_TIMEOUT_MS),
    concurrency: getNumberFlag(args, "concurrency", DEFAULT_CONCURRENCY),
    trace: true,
  });

  const accepted = decisions.filter((decision): decision is Extract<RedirectDecision, { kind: "alias" }> => decision.kind === "alias");
  const rejected = decisions.filter((decision) => decision.kind === "rejected");
  const noAlias = decisions.filter((decision) => decision.kind === "no_alias");

  if (hasFlag(args, "json")) {
    console.log(JSON.stringify({ accepted, rejected, noAlias }, null, 2));
  } else {
    for (const decision of decisions) {
      const line = formatDecision(decision, hasFlag(args, "verbose"));
      if (line) console.log(line);
    }
    console.log(`summary: accepted=${accepted.length} rejected=${rejected.length} no_alias=${noAlias.length}`);
  }

  if (!hasFlag(args, "apply")) return;

  const acceptedAliases = accepted.map((decision) => ({ source: decision.source, target: decision.target }));
  const applyMissingTargets = hasFlag(args, "apply-missing-targets");
  const newAliases = applyMissingTargets
    ? acceptedAliases
    : acceptedAliases.filter((alias) => hasCatalogRecord(catalogDir, alias.target));
  const skippedMissingTargets = acceptedAliases.filter((alias) => !newAliases.some((applied) => applied.source === alias.source));
  const aliasWrite = upsertDomainAliasesFile(newAliases);
  const mergeResults = mergeAliasCatalogFiles(catalogDir, newAliases);
  if (!hasFlag(args, "json")) {
    console.log(`aliases file changed=${aliasWrite.changed} added=${aliasWrite.added.length}`);
    for (const alias of skippedMissingTargets) {
      console.log(`alias skipped missing target catalog record: ${alias.source} -> ${alias.target}`);
    }
    for (const result of mergeResults) {
      console.log(`catalog ${result.action}: ${result.source} -> ${result.target}`);
    }
  }
}

if (import.meta.main) await main();
