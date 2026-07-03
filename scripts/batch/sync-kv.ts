import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  catalogDomainFromLooseStored,
  catalogDomainKey,
  DEFAULT_DOMAIN_CATALOG_DIR,
  mergeCatalogs,
  readDomainCatalogTree,
  type Catalog,
  type CatalogDomain,
  writeDomainCatalogTree,
} from "./discovered-catalog.ts";
import { getFlag, hasFlag, parseArgs, ROOT, usage } from "./shared.ts";

const DISCOVERY_NAMESPACE_ID = "7456151d9722471ca000f6d3b03a62c7";
const BULK_CHUNK_SIZE = 100;

const HELP = `
Usage: bun scripts/batch/sync-kv.ts [flags]

Pulls DISCOVERY KV rows into the per-domain domains/ catalog tree.

Flags:
  --local              Read local wrangler KV instead of production KV
  --dry-run            Print counts and a sample diff, write nothing
  --out dir            Catalog tree output directory (default: domains)
  --help               Show this help
`;

type KvRow = { key: string; value: string };

export type SyncSummary = {
  keysListed: number;
  skippedInvalid: number;
  parsed: number;
  mergedNew: number;
  updated: number;
  unchanged: number;
};

function validDomainKey(key: string): string | null {
  const domain = key.trim().toLowerCase().replace(/\.$/, "");
  return catalogDomainKey(domain) ? domain : null;
}

function wrangler(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bunx", "wrangler", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function parseKeyList(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error("wrangler key list did not return an array");
  return parsed.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") return [(item as { name: string }).name];
    return [];
  });
}

function parseBulkJson(value: unknown): KvRow[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (Array.isArray(item) && typeof item[0] === "string") {
        return [{ key: item[0], value: typeof item[1] === "string" ? item[1] : JSON.stringify(item[1]) }];
      }
      if (!item || typeof item !== "object") return [];
      const row = item as { key?: unknown; name?: unknown; value?: unknown };
      const key = typeof row.key === "string" ? row.key : typeof row.name === "string" ? row.name : undefined;
      if (!key || row.value == null) return [];
      return [{ key, value: typeof row.value === "string" ? row.value : JSON.stringify(row.value) }];
    });
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.values)) return parseBulkJson(record.values);
    return Object.entries(record).flatMap(([key, item]) => {
      if (item == null) return [];
      return [{ key, value: typeof item === "string" ? item : JSON.stringify(item) }];
    });
  }
  return [];
}

function parseBulkOutput(stdout: string): KvRow[] {
  // wrangler prints the JSON document followed by a bare "Success!" line, so
  // parse the outermost {...}/[...] slice rather than the whole stream.
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const start = trimmed.search(/[[{]/);
  if (start === -1) return [];
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (end <= start) return [];
  return parseBulkJson(JSON.parse(trimmed.slice(start, end + 1)));
}

function listKeys(local: boolean): string[] {
  const args = local
    ? ["kv", "key", "list", "--binding=DISCOVERY", "--local"]
    : ["kv", "key", "list", "--namespace-id", DISCOVERY_NAMESPACE_ID, "--remote"];
  const result = wrangler(args);
  if (!result.ok) throw new Error(`wrangler kv key list failed:\n${result.stderr || result.stdout}`);
  return parseKeyList(result.stdout);
}

function bulkGet(keys: string[], local: boolean, chunkIndex: number): KvRow[] {
  const keysPath = join(tmpdir(), `integrations-sync-kv-keys-${process.pid}-${chunkIndex}.json`);
  mkdirSync(join(keysPath, ".."), { recursive: true });
  writeFileSync(keysPath, `${JSON.stringify(keys, null, 2)}\n`);
  const args = local
    ? ["kv", "bulk", "get", keysPath, "--binding=DISCOVERY", "--local"]
    : ["kv", "bulk", "get", keysPath, "--namespace-id", DISCOVERY_NAMESPACE_ID, "--remote"];

  try {
    for (const attempt of [1, 2]) {
      const result = wrangler(args);
      if (result.ok) return parseBulkOutput(result.stdout);
      if (attempt === 2) {
        console.warn(`sync-kv: skipping chunk ${chunkIndex} after bulk get failure:\n${result.stderr || result.stdout}`);
        return [];
      }
      console.warn(`sync-kv: retrying chunk ${chunkIndex} after bulk get failure`);
    }
  } finally {
    try {
      unlinkSync(keysPath);
    } catch {
      // Best-effort temp-file cleanup.
    }
  }
  return [];
}

function sampleDiff(changes: ReturnType<typeof mergeCatalogs>["changes"], limit = 8): string {
  if (changes.length === 0) return "sample diff: no catalog changes";
  const lines = changes.slice(0, limit).map((change) => {
    if (change.kind === "new") return `+ ${change.domain} (${change.nextDiscoveredAt ?? "unknown date"})`;
    return `~ ${change.domain} (${change.previousDiscoveredAt ?? "unknown"} -> ${change.nextDiscoveredAt ?? "unknown"})`;
  });
  if (changes.length > limit) lines.push(`... ${changes.length - limit} more`);
  return `sample diff:\n${lines.join("\n")}`;
}

export function mergeDiscoveredCatalog(existing: Catalog, incoming: readonly CatalogDomain[]): ReturnType<typeof mergeCatalogs> {
  return mergeCatalogs(existing, incoming);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);

  const local = hasFlag(args, "local");
  const dryRun = hasFlag(args, "dry-run");
  const outDir = resolve(ROOT, getFlag(args, "out", DEFAULT_DOMAIN_CATALOG_DIR)!);

  const keys = listKeys(local);
  const validKeys: string[] = [];
  let skippedInvalid = 0;
  for (const key of keys) {
    const domain = validDomainKey(key);
    if (!domain) {
      skippedInvalid++;
      continue;
    }
    validKeys.push(domain);
  }

  const rows: KvRow[] = [];
  for (let i = 0; i < validKeys.length; i += BULK_CHUNK_SIZE) {
    rows.push(...bulkGet(validKeys.slice(i, i + BULK_CHUNK_SIZE), local, Math.floor(i / BULK_CHUNK_SIZE)));
  }

  const incoming: CatalogDomain[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      const domain = catalogDomainFromLooseStored(parsed, row.key);
      if (!domain) {
        console.warn(`sync-kv: skipped ${row.key}: no usable discovery result`);
        continue;
      }
      if (!catalogDomainKey(domain.domain)) {
        skippedInvalid++;
        console.warn(`sync-kv: skipped ${row.key}: invalid registrable domain ${domain.domain}`);
        continue;
      }
      incoming.push(domain);
    } catch (err) {
      console.warn(`sync-kv: skipped ${row.key}: ${(err as Error).message}`);
    }
  }

  const existing = readDomainCatalogTree(outDir);
  const merged = mergeDiscoveredCatalog(existing, incoming);
  const summary: SyncSummary = {
    keysListed: keys.length,
    skippedInvalid,
    parsed: incoming.length,
    mergedNew: merged.stats.new,
    updated: merged.stats.updated,
    unchanged: merged.stats.unchanged,
  };

  console.log(
    [
      `keys listed: ${summary.keysListed}`,
      `skipped invalid: ${summary.skippedInvalid}`,
      `parsed: ${summary.parsed}`,
      `domain files added: ${summary.mergedNew}`,
      `domain files updated: ${summary.updated}`,
      `domain files unchanged: ${summary.unchanged}`,
    ].join("\n"),
  );

  if (dryRun) {
    console.log(sampleDiff(merged.changes));
    return;
  }

  const written = writeDomainCatalogTree(outDir, merged.catalog.domains);
  for (const skip of written.skipped) {
    console.warn(`sync-kv: skipped ${skip.domain}: ${skip.reason}`);
  }
  console.log(`wrote ${written.written} domain files to ${outDir} (${written.changed} changed)`);
}

if (import.meta.main) await main();
