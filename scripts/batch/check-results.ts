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
    const row = readJson<{ result?: { domain?: string; detect?: unknown; credentials?: unknown; surfaces?: readonly unknown[] }; visited?: string[]; grounding?: string[] }>(file);
    const result = row.result;
    const domain = result?.domain ?? file.split("/").pop()!.replace(/\.json$/, "");
    if (!result) {
      failed++;
      console.log(`${domain}\tfail\tmissing result`);
      continue;
    }
    // Loop results carry `visited` (live scrape trail) — ground against that,
    // not a corpus file that some earlier one-shot run may have left behind.
    const checks = row.visited ? checklist(result, undefined, row.visited, row.grounding) : checklist(result, corpusText(corpusDir, domain));
    // outputUrlsGrounded offenders that answer a live probe are real — the
    // loop read them from a rendering the trail didn't capture verbatim.
    if (hasFlag(args, "probe") && checks.checks.outputUrlsGrounded && !checks.checks.outputUrlsGrounded.passed) {
      const still: string[] = [];
      for (const url of checks.checks.outputUrlsGrounded.offenders ?? []) {
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) });
            // Any HTTP response proves the host is real — invented hosts fail
            // DNS. Bare API bases 404 by design (routes live under paths).
            ok = res.status < 500;
          } catch {
            /* transient network flake — retry once */
          }
        }
        if (!ok) still.push(url);
      }
      checks.checks.outputUrlsGrounded = { passed: still.length === 0, offenders: still };
      checks.passed = Object.values(checks.checks).every((check) => check.passed);
    }
    const bad = Object.entries(checks.checks).filter(([, check]) => !check.passed).map(([name]) => name);
    const driftAdvisory = checks.checks.noDomainDrift?.offenders ?? [];
    if (driftAdvisory.length) console.log(`${domain}\tADVISORY\tpossible domain drift -> ${driftAdvisory.join(",")}`);
    if (!checks.passed) failed++;
    console.log(`${domain}\t${checks.passed ? "pass" : "fail"}${bad.length ? `\t${bad.join(",")}` : ""}`);
  }
  console.log(`summary files=${files.length} failed=${failed}`);
  if (failed) process.exit(1);
}

await main();
