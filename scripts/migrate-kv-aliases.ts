// One-shot: migrate DISCOVERY KV rows from alias keys to canonical keys.
//   bun scripts/migrate-kv-aliases.ts --dry-run # local KV (wrangler --local state)
//   bun scripts/migrate-kv-aliases.ts           # local KV (writes)
//   bun scripts/migrate-kv-aliases.ts --remote  # production KV (writes)
//
// For each alias -> canonical pair:
//   - if only the alias key exists, copy its value to the canonical key
//   - if both exist, keep the canonical value and log the conflict
//   - delete the alias key after a real run
import { execFileSync } from "node:child_process";
import { DOMAIN_ALIASES, canonicalDomain } from "../src/lib/domain-aliases.ts";

const REMOTE = process.argv.includes("--remote");
const DRY_RUN = process.argv.includes("--dry-run");
const FLAG = REMOTE ? "--remote" : "--local";

const wrangler = (...args: string[]): string =>
  execFileSync("bunx", ["wrangler", ...args, FLAG], { encoding: "utf8" });

const keys = new Set(
  (JSON.parse(wrangler("kv", "key", "list", "--binding", "DISCOVERY")) as { name: string }[])
    .map((k) => k.name),
);

console.log(`${keys.size} row(s) in ${REMOTE ? "REMOTE" : "local"} DISCOVERY`);
if (DRY_RUN) console.log("Dry run: no KV writes or deletes will be performed.");

for (const [alias, target] of Object.entries(DOMAIN_ALIASES)) {
  const canonical = canonicalDomain(target);
  if (!keys.has(alias)) {
    console.log(`  ${alias} -> ${canonical}: no alias row`);
    continue;
  }

  const canonicalExists = keys.has(canonical);
  if (canonicalExists) {
    console.log(`  ${alias} -> ${canonical}: conflict; canonical row already exists, keeping it`);
  } else {
    console.log(`  ${alias} -> ${canonical}: ${DRY_RUN ? "would copy" : "copying"} alias row to canonical key`);
    if (!DRY_RUN) {
      const raw = wrangler("kv", "key", "get", alias, "--binding", "DISCOVERY");
      const tmp = `/tmp/kv-alias-${alias.replace(/[^a-z0-9.-]/gi, "_")}.json`;
      await Bun.write(tmp, raw);
      wrangler("kv", "key", "put", canonical, "--binding", "DISCOVERY", "--path", tmp);
      keys.add(canonical);
    }
  }

  console.log(`  ${alias} -> ${canonical}: ${DRY_RUN ? "would delete" : "deleting"} alias row`);
  if (!DRY_RUN) {
    wrangler("kv", "key", "delete", alias, "--binding", "DISCOVERY");
    keys.delete(alias);
  }
}

console.log("Done.");
