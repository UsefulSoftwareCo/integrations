import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractDomains, getFlag, hasFlag, parseArgs, readJson, readLines, registrable, ROOT, usage } from "./shared.ts";

const HELP = `
Usage: bun scripts/batch/expand-domains.ts [flags]

Flags:
  --exclude file      File of domains that already have KV discovery rows
  --out file          Output list (default: scripts/batch/domains-all.txt)
  --help              Show this help
`;

function indexDomains(): Set<string> {
  const rows = readJson<Array<{ domain?: string; url?: string; icon?: string }>>(join(ROOT, "output", "index.json"));
  const out = new Set<string>();
  for (const row of rows) {
    const d = registrable(row.domain ?? "") ?? registrable(row.url ?? "") ?? registrable(row.icon ?? "");
    if (d) out.add(d);
  }
  return out;
}

function sourceDomains(): Set<string> {
  const out = new Set<string>();
  const dir = join(ROOT, "sources");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      extractDomains(JSON.parse(readFileSync(join(dir, name), "utf8")), out);
    } catch {
      /* source feeds are best-effort */
    }
  }
  return out;
}

function seedDomains(): Set<string> {
  const out = new Set<string>();
  // Every seed-domains*.txt file counts — curated lists accrete over time.
  const dir = join(ROOT, "scripts", "batch");
  for (const name of readdirSync(dir)) {
    if (!/^seed-domains.*\.txt$/.test(name)) continue;
    for (const line of readLines(join(dir, name))) {
      const d = registrable(line);
      if (d) out.add(d);
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const outPath = getFlag(args, "out", join(ROOT, "scripts", "batch", "domains-all.txt"))!;
  const excluded = new Set<string>();
  const excludePath = getFlag(args, "exclude");
  if (excludePath && existsSync(excludePath)) {
    for (const line of readLines(excludePath)) {
      const d = registrable(line);
      if (d) excluded.add(d);
    }
  }

  const fromIndex = indexDomains();
  const fromSources = sourceDomains();
  const fromSeed = seedDomains();
  const all = new Set<string>([...fromIndex, ...fromSources, ...fromSeed]);
  for (const d of excluded) all.delete(d);
  const domains = [...all].sort();

  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, `${domains.join("\n")}\n`);
  console.log(`index=${fromIndex.size} sources=${fromSources.size} seed=${fromSeed.size} excluded=${excluded.size} wrote=${domains.length} out=${outPath}`);
}

main();
