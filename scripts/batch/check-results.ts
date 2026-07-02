import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checklist } from "./eval-discovery.ts";
import { getFlag, hasFlag, listJsonFiles, parseArgs, readJson, ROOT, safeDomainFile, usage } from "./shared.ts";

const HELP = `
Usage: bun scripts/batch/check-results.ts --dir results/ [flags]

Flags:
  --corpus dir       Optional corpus dir for exact URL grounding
  --help             Show this help
`;

function corpusText(corpusDir: string | undefined, domain: string): string | undefined {
  if (!corpusDir) return undefined;
  const path = join(corpusDir, `${safeDomainFile(domain)}.json`);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const dir = getFlag(args, "dir");
  if (!dir) usage(HELP);
  const corpusDir = getFlag(args, "corpus", join(ROOT, "scripts", "batch", "corpus"));
  const files = listJsonFiles(dir);
  if (!files.length) throw new Error(`no result JSON files found in ${dir}`);

  let failed = 0;
  for (const file of files) {
    const row = readJson<{ result?: { domain?: string; detect?: unknown; credentials?: unknown; surfaces?: readonly unknown[] }; visited?: string[] }>(file);
    const result = row.result;
    const domain = result?.domain ?? file.split("/").pop()!.replace(/\.json$/, "");
    if (!result) {
      failed++;
      console.log(`${domain}\tfail\tmissing result`);
      continue;
    }
    // Loop results carry `visited` (live scrape trail) — ground against that,
    // not a corpus file that some earlier one-shot run may have left behind.
    const checks = row.visited ? checklist(result, undefined, row.visited) : checklist(result, corpusText(corpusDir, domain));
    const bad = Object.entries(checks.checks).filter(([, check]) => !check.passed).map(([name]) => name);
    if (!checks.passed) failed++;
    console.log(`${domain}\t${checks.passed ? "pass" : "fail"}${bad.length ? `\t${bad.join(",")}` : ""}`);
  }
  console.log(`summary files=${files.length} failed=${failed}`);
  if (failed) process.exit(1);
}

await main();
