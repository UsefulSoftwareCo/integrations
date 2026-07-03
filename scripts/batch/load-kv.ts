import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDomain, getFlag, hasFlag, listJsonFiles, parseArgs, ROOT, run, usage } from "./shared.ts";

const HELP = `
Usage: bun scripts/batch/load-kv.ts --dir scripts/batch/results/ [flags]

Flags:
  --dry-run            Write bulk file and print counts, do not invoke wrangler
  --only a.com,b.com   Limit to comma-separated domains
  --remote             Write production KV instead of local KV
  --overwrite          Allow overwriting existing remote rows
  --bulk-file file     Bulk JSON path (default: scripts/batch/kv-bulk.json)
  --help               Show this help
`;

function remoteExists(domain: string): boolean {
  const proc = Bun.spawnSync(["bunx", "wrangler", "kv", "key", "get", domain, "--binding=DISCOVERY", "--remote"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 && proc.stdout.toString().trim().length > 0;
}

function main(): void {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const dir = getFlag(args, "dir");
  if (!dir) usage(HELP);
  const remote = hasFlag(args, "remote");
  const overwrite = hasFlag(args, "overwrite");
  const dryRun = hasFlag(args, "dry-run");
  const onlyRaw = getFlag(args, "only");
  const only = onlyRaw ? new Set(onlyRaw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)) : null;
  const bulkPath = getFlag(args, "bulk-file", join(ROOT, "scripts", "batch", "kv-bulk.json"))!;

  const rows: Array<{ key: string; value: string }> = [];
  for (const path of listJsonFiles(dir)) {
    const domain = fileDomain(path);
    if (only && !only.has(domain)) continue;
    if (remote && !overwrite && remoteExists(domain)) {
      console.log(`${domain} remote exists; skipped`);
      continue;
    }
    rows.push({ key: domain, value: readFileSync(path, "utf8") });
  }

  mkdirSync(join(bulkPath, ".."), { recursive: true });
  writeFileSync(bulkPath, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`prepared rows=${rows.length} file=${bulkPath} target=${remote ? "remote" : "local"}`);
  if (dryRun) return;
  if (!existsSync(bulkPath)) throw new Error(`missing bulk file: ${bulkPath}`);
  const wranglerArgs = ["wrangler", "kv", "bulk", "put", bulkPath, "--binding=DISCOVERY"];
  if (remote) wranglerArgs.push("--remote");
  else wranglerArgs.push("--local");
  run("bunx", wranglerArgs);
}

main();
