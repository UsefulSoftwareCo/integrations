import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getFlag, hasFlag, parseArgs, readJson, ROOT, usage } from "./shared.ts";
import { catalogDomainFromStored, catalogDomainKey, DEFAULT_DOMAIN_CATALOG_DIR, type CatalogDomain, writeDomainCatalogTree } from "./discovered-catalog.ts";
import type { StoredDiscovery } from "../../src/lib/discovery-schema.ts";

const args = parseArgs();

if (hasFlag(args, "help")) {
  usage(`
Usage: bun scripts/batch/export-catalog.ts --results-dir dir [--out domains]

Exports compact catalog entries from StoredDiscovery result files.
Domains with zero surfaces are included. Credentials, notes, and other
discovery-only details are intentionally omitted.
`);
}

const resultsDirFlag = getFlag(args, "results-dir");
if (!resultsDirFlag) usage("Usage: bun scripts/batch/export-catalog.ts --results-dir dir [--out domains]");
const resultsDir = resolve(ROOT, resultsDirFlag);
const outDir = resolve(ROOT, getFlag(args, "out", DEFAULT_DOMAIN_CATALOG_DIR)!);

if (!existsSync(resultsDir)) throw new Error(`Results directory not found: ${resultsDir}`);

const domainMap = new Map<string, CatalogDomain>();

for (const file of readdirSync(resultsDir).sort()) {
  if (!file.endsWith(".json")) continue;
  const path = join(resultsDir, file);
  const stored = readJson<StoredDiscovery>(path);
  const domain = catalogDomainFromStored(stored);
  const key = catalogDomainKey(domain?.domain);
  if (!domain || !key) continue;
  domainMap.set(key, domain);
}

const domains = [...domainMap.values()];
const written = writeDomainCatalogTree(outDir, domains);
for (const skip of written.skipped) {
  console.warn(`export-catalog: skipped ${skip.domain}: ${skip.reason}`);
}

console.log(`wrote ${written.written} domain files to ${outDir} (${written.changed} changed)`);
