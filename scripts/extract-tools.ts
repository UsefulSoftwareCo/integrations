// Extract tool lists per integration using @executor-js/* plugins.
// Caches to output/tools/<kind>/<slug>.json so re-runs only hit new sources.
//
// Usage:
//   bun run extract-tools                  # all kinds, only uncached
//   bun run extract-tools -- --kind=openapi
//   bun run extract-tools -- --limit=200
//   bun run extract-tools -- --refresh     # ignore cache
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createExecutor } from "@executor-js/sdk";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { graphqlPlugin } from "@executor-js/plugin-graphql";
import type { Integration, Kind } from "../src/lib/types.ts";

const ROOT = import.meta.dir.replace(/\/scripts$/, "");
const OUTPUT = join(ROOT, "output");
const CACHE = join(OUTPUT, "tools");

const args = new Map<string, string>(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [[m[1], m[2] ?? "true"]] : [];
  }),
);
const FILTER_KIND = args.get("kind") as Kind | undefined;
const LIMIT = args.has("limit") ? Number(args.get("limit")) : Infinity;
const REFRESH = args.has("refresh");
const CONCURRENCY = Number(args.get("concurrency") ?? 8);
const TIMEOUT_MS = Number(args.get("timeout") ?? 30_000);

interface ToolEntry {
  id: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface ToolsCache {
  fetchedAt: string;
  status: "ok" | "error" | "skipped";
  reason?: string;
  count: number;
  tools: ToolEntry[];
}

const cachePath = (kind: Kind, slug: string) => join(CACHE, kind, `${slug}.json`);

function readCache(kind: Kind, slug: string): ToolsCache | null {
  const p = cachePath(kind, slug);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ToolsCache;
}

function writeCache(kind: Kind, slug: string, data: ToolsCache) {
  const p = cachePath(kind, slug);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function pmap<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

const isAuthlessMcp = (item: Integration): boolean => {
  const m = item.mcp;
  if (!m) return false;
  if (m.isAuthless === true) return true;
  if (m.authTypes && m.authTypes.length > 0) {
    return m.authTypes.every((t) => t.toUpperCase() === "NONE");
  }
  return false;
};

const skipped = (reason: string): ToolsCache => ({
  fetchedAt: new Date().toISOString(),
  status: "skipped",
  reason,
  count: 0,
  tools: [],
});

const errored = (reason: string): ToolsCache => ({
  fetchedAt: new Date().toISOString(),
  status: "error",
  reason,
  count: 0,
  tools: [],
});

const ok = (tools: ToolEntry[]): ToolsCache => ({
  fetchedAt: new Date().toISOString(),
  status: "ok",
  count: tools.length,
  tools,
});

interface RawTool {
  id?: string | { toString(): string };
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

const projectTool = (t: RawTool, namespace: string): ToolEntry | null => {
  const id = String(t.id ?? "");
  if (!id) return null;
  // Strip namespace prefix that the plugin adds, so tools list cleanly.
  const stripped = id.startsWith(`${namespace}.`) ? id.slice(namespace.length + 1) : id;
  return {
    id,
    name: t.name ?? stripped,
    description: t.description,
    inputSchema: t.inputSchema,
  };
};

async function extractMcp(item: Integration): Promise<ToolsCache> {
  if (!item.mcp?.remoteUrl) return skipped("no remote URL");
  if (!isAuthlessMcp(item)) return skipped("auth required");
  const namespace = `mcp_${item.slug}`.replace(/[^a-z0-9_]/g, "_");
  const exec = await createExecutor({
    scope: { name: `extract-${item.slug}` },
    plugins: [mcpPlugin()] as const,
  });
  try {
    await exec.mcp.addSource({
      transport: "remote",
      name: namespace,
      endpoint: item.mcp.remoteUrl,
    });
    const tools = await exec.tools.list();
    return ok(
      tools
        .map((t) => projectTool(t as RawTool, namespace))
        .filter((t): t is ToolEntry => t !== null),
    );
  } finally {
    await exec.close().catch(() => {});
  }
}

async function extractOpenapi(item: Integration): Promise<ToolsCache> {
  const spec = item.openapi?.specUrl;
  if (!spec) return skipped("no spec URL");
  const namespace = `openapi_${item.slug}`.replace(/[^a-z0-9_]/g, "_");
  const exec = await createExecutor({
    scope: { name: `extract-${item.slug}` },
    plugins: [openApiPlugin()] as const,
  });
  try {
    await exec.openapi.addSpec({ spec, namespace });
    const tools = await exec.tools.list();
    return ok(
      tools
        .map((t) => projectTool(t as RawTool, namespace))
        .filter((t): t is ToolEntry => t !== null),
    );
  } finally {
    await exec.close().catch(() => {});
  }
}

async function extractGraphql(item: Integration): Promise<ToolsCache> {
  const endpoint = item.graphql?.endpoint;
  if (!endpoint) return skipped("no endpoint");
  if (item.graphql?.hasSecurity) return skipped("auth required");
  const namespace = `graphql_${item.slug}`.replace(/[^a-z0-9_]/g, "_");
  const exec = await createExecutor({
    scope: { name: `extract-${item.slug}` },
    plugins: [graphqlPlugin()] as const,
  });
  try {
    await exec.graphql.addSource({ endpoint, namespace });
    const tools = await exec.tools.list();
    return ok(
      tools
        .map((t) => projectTool(t as RawTool, namespace))
        .filter((t): t is ToolEntry => t !== null),
    );
  } finally {
    await exec.close().catch(() => {});
  }
}

const extractors: Record<Kind, (item: Integration) => Promise<ToolsCache>> = {
  mcp: extractMcp,
  openapi: extractOpenapi,
  graphql: extractGraphql,
};

async function processKind(kind: Kind) {
  const file = join(OUTPUT, `${kind}.json`);
  const items = JSON.parse(readFileSync(file, "utf8")) as Integration[];

  const candidates = items.filter((item) => {
    if (!REFRESH && readCache(kind, item.slug)) return false;
    if (kind === "mcp" && !isAuthlessMcp(item)) return false;
    if (kind === "openapi" && !item.openapi?.specUrl) return false;
    if (kind === "graphql" && item.graphql?.hasSecurity) return false;
    return true;
  });

  const work = candidates.slice(0, LIMIT === Infinity ? candidates.length : LIMIT);
  console.log(`${kind}: ${work.length} to process (${items.length} total, ${items.length - candidates.length} ineligible/cached)`);

  let ok = 0, err = 0, skip = 0;
  let started = Date.now();
  await pmap(work, CONCURRENCY, async (item, i) => {
    let result: ToolsCache;
    try {
      result = await withTimeout(extractors[kind](item), TIMEOUT_MS, item.slug);
    } catch (e) {
      result = errored((e as Error).message.slice(0, 200));
    }
    writeCache(kind, item.slug, result);
    if (result.status === "ok") ok++;
    else if (result.status === "skipped") skip++;
    else err++;
    if ((i + 1) % 25 === 0 || i + 1 === work.length) {
      const dt = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${work.length}] ok=${ok} err=${err} skip=${skip} (${dt}s)`);
    }
  });
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const kinds: Kind[] = FILTER_KIND ? [FILTER_KIND] : ["openapi", "mcp", "graphql"];
  for (const k of kinds) {
    await processKind(k);
  }
}

await main();
