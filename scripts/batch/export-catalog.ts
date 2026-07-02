import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getFlag, hasFlag, parseArgs, readJson, ROOT, usage, writeJson } from "./shared.ts";
import type { AuthStatus, StoredDiscovery, Surface } from "../../src/lib/discovery-schema.ts";

type CatalogSurface = {
  slug: string;
  name: string;
  type: Surface["type"];
  url?: string;
  spec?: string;
  command?: string;
  authStatus: AuthStatus["status"];
};

type CatalogDomain = {
  domain: string;
  summary: string;
  surfaces: CatalogSurface[];
};

type Catalog = {
  domains: CatalogDomain[];
};

const args = parseArgs();

if (hasFlag(args, "help")) {
  usage(`
Usage: bun scripts/batch/export-catalog.ts [--results-dir scripts/batch/results-full] [--out sources/discovered.json]

Exports compact catalog entries from StoredDiscovery result files.
Only domains with at least one surface are included. Credentials, notes, and
other discovery-only details are intentionally omitted. The default export also
includes scripts/batch/results as a small seed backfill; explicit --results-dir
exports only that directory.
`);
}

const explicitResultsDir = args.flags.has("results-dir");
const resultsDir = resolve(ROOT, getFlag(args, "results-dir", "scripts/batch/results-full")!);
const outPath = resolve(ROOT, getFlag(args, "out", "sources/discovered.json")!);

function compactSurface(surface: Surface): CatalogSurface {
  const out: CatalogSurface = {
    slug: surface.slug,
    name: surface.name,
    type: surface.type,
    authStatus: surface.auth.status,
  };
  if ("url" in surface && surface.url) out.url = surface.url;
  if ("spec" in surface && surface.spec) out.spec = surface.spec;
  if (surface.type === "cli" && surface.command) out.command = surface.command;
  return out;
}

if (!existsSync(resultsDir)) throw new Error(`Results directory not found: ${resultsDir}`);

const domainMap = new Map<string, CatalogDomain>();
const resultDirs = [resultsDir];
const seedBackfillDir = join(ROOT, "scripts/batch/results");
if (!explicitResultsDir && existsSync(seedBackfillDir)) resultDirs.push(seedBackfillDir);

for (const dir of resultDirs) {
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const stored = readJson<StoredDiscovery>(path);
    const result = stored.result;
    const surfaces = (result.surfaces ?? []).map(compactSurface);
    if (surfaces.length === 0) continue;
    domainMap.set(result.domain.toLowerCase(), {
      domain: result.domain.toLowerCase(),
      summary: result.summary,
      surfaces,
    });
  }
}

const domains = [...domainMap.values()];
domains.sort((a, b) => a.domain.localeCompare(b.domain));
writeJson(outPath, { domains } satisfies Catalog);

console.log(`wrote ${domains.length} domains to ${outPath}`);
