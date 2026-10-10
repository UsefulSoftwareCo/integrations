#!/usr/bin/env bun
/**
 * Records the security-relevant slice of every catalogued OpenAPI spec (its
 * servers, securitySchemes and security requirements) in output/openapi-auth.json.
 * normalize.ts derives each surface's feed `auth` from it.
 *
 * Like output/mcp-endpoints.json this is a slow network cache, tracked in git
 * and only READ by `normalize.ts`; nothing here runs at build or request time.
 * Entries are keyed by spec URL (plus a hash of any curated spec overrides, which
 * change the document). A re-check sends the stored ETag and skips the
 * re-parse when the server answers 304 or the body hash is unchanged.
 *
 * Usage (after `bun run normalize`, which writes output/openapi.json):
 *   bun scripts/extract-openapi-auth.ts            # only specs missing from the cache
 *   bun scripts/extract-openapi-auth.ts --stale 30 # also re-check entries older than 30 days
 *   bun scripts/extract-openapi-auth.ts --all      # re-check everything
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { Integration } from "../src/lib/types.ts";
import { SLIM_VERSION, slimSpec } from "../src/lib/openapi-auth.ts";
import { applyJsonPatch, specAuthKey } from "../src/lib/openapi-auth-cache.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "output", "openapi-auth.json");
const RECORDS = join(ROOT, "output", "openapi.json");

const CONCURRENCY = 16;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 60 * 1024 * 1024;

interface Entry {
  checkedAt: string;
  etag?: string;
  sha256?: string;
  /** The security-relevant slice of the document (`slimSpec`), and the
   *  slicer version that produced it. */
  spec?: unknown;
  v?: number;
  error?: string;
}

interface Cache {
  checkedAt: string;
  specs: Record<string, Entry>;
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const staleIdx = args.indexOf("--stale");
const staleDays = staleIdx >= 0 ? Number(args[staleIdx + 1]) : undefined;

const cache: Cache = existsSync(CACHE)
  ? (JSON.parse(readFileSync(CACHE, "utf8")) as Cache)
  : { checkedAt: new Date(0).toISOString(), specs: {} };

if (!existsSync(RECORDS)) {
  console.error("output/openapi.json missing — run `bun run normalize` first");
  process.exit(1);
}
const records = JSON.parse(readFileSync(RECORDS, "utf8")) as Integration[];

const jobs = new Map<string, { url: string; overrides?: unknown[] }>();
for (const r of records) {
  const url = r.openapi?.specUrl;
  if (!url || !/^https?:\/\//.test(url)) continue;
  const overrides = r.openapi?.specOverrides;
  jobs.set(specAuthKey(url, overrides), { url, ...(overrides?.length ? { overrides } : {}) });
}

const now = Date.now();
const due = [...jobs.entries()].filter(([key]) => {
  const e = cache.specs[key];
  if (!e || all || e.v !== SLIM_VERSION) return true;
  if (staleDays === undefined) return false;
  return now - Date.parse(e.checkedAt) > staleDays * 86_400_000;
});

console.log(`openapi-auth: ${jobs.size} specs, ${due.length} to check`);

const parse = (body: string): unknown => {
  const t = body.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  return parseYaml(body, { maxAliasCount: -1 });
};

async function check(key: string, url: string, overrides: unknown[] | undefined): Promise<Entry> {
  const cached = cache.specs[key];
  // A slice from an older slicer cannot be reused, even for an unchanged body.
  const prev = cached?.v === SLIM_VERSION ? cached : undefined;
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json, application/yaml, text/yaml, */*",
        "user-agent": "integrations.sh-openapi-auth",
        ...(prev?.etag && prev.spec ? { "if-none-match": prev.etag } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.status === 304 && prev?.spec) return { ...prev, checkedAt };
    if (!res.ok) return { checkedAt, error: `HTTP ${res.status}`, ...(prev?.spec ? { spec: prev.spec, v: prev.v, sha256: prev.sha256 } : {}) };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) return { checkedAt, error: "too large" };
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const etag = res.headers.get("etag") ?? undefined;
    if (prev?.spec && prev.sha256 === sha256) return { ...prev, checkedAt, ...(etag ? { etag } : {}) };
    let doc = parse(new TextDecoder().decode(buf));
    if (overrides?.length) doc = applyJsonPatch(doc, overrides);
    return { checkedAt, ...(etag ? { etag } : {}), sha256, v: SLIM_VERSION, spec: slimSpec(doc) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Keep the last good summary: a network blip is not evidence the spec changed.
    return { checkedAt, error: msg.slice(0, 160), ...(prev?.spec ? { spec: prev.spec, v: prev.v, sha256: prev.sha256, etag: prev.etag } : {}) };
  }
}

let done = 0;
let cursor = 0;
const save = () => {
  // Drop entries for specs no longer catalogued so the cache tracks the catalog.
  const specs: Record<string, Entry> = {};
  for (const key of [...jobs.keys()].sort()) if (cache.specs[key]) specs[key] = cache.specs[key]!;
  // One line per spec keeps the nightly diff readable without a 2 MB indent.
  const lines = Object.entries(specs).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  writeFileSync(CACHE, `{\n "checkedAt": ${JSON.stringify(new Date().toISOString())},\n "specs": {\n${lines.join(",\n")}\n }\n}\n`);
};
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < due.length) {
      const [key, job] = due[cursor++]!;
      cache.specs[key] = await check(key, job.url, job.overrides);
      if (++done % 100 === 0) {
        console.log(`  ${done}/${due.length}`);
        save();
      }
    }
  }),
);
save();

const entries = Object.values(cache.specs);
console.log(
  `openapi-auth: ${entries.filter((e) => e.spec).length} summarized, ${entries.filter((e) => e.error).length} errors`,
);
