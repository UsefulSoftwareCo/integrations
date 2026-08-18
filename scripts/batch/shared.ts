import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Schema } from "effect";
import { parse as parseDomain } from "tldts";
import { DiscoveryResult as DiscoveryResultSchema, type DiscoveryResult } from "../../src/lib/discovery-schema.ts";
import { assignSlug } from "../../src/lib/discover.ts";
import { preserveSlugs } from "../../worker/operations.ts";
import { dedupSurfacesWithReport, type DedupCollapse } from "../../src/lib/dedup.ts";

export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export type Args = {
  flags: Map<string, string[]>;
  positionals: string[];
};

export function parseArgs(argv = Bun.argv.slice(2)): Args {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
    const values = flags.get(key) ?? [];
    values.push(value);
    flags.set(key, values);
  }
  return { flags, positionals };
}

export const hasFlag = (args: Args, name: string): boolean => args.flags.has(name);
export const getFlag = (args: Args, name: string, fallback?: string): string | undefined => args.flags.get(name)?.at(-1) ?? fallback;
export const getNumberFlag = (args: Args, name: string, fallback: number): number => {
  const n = Number(getFlag(args, name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function usage(text: string): never {
  console.log(text.trimStart());
  process.exit(0);
}

export function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function safeDomainFile(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9.-]+/g, "_");
}

export function registrable(input: string): string | null {
  const value = input.includes("://") ? input : `https://${input}`;
  const info = parseDomain(value, { allowPrivateDomains: true });
  if (info.isIp || !info.domain || !(info.isIcann || info.isPrivate)) return null;
  return info.domain.toLowerCase();
}

export function extractDomains(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const urlish = value.match(/https?:\/\/[^\s"'<>),]+/g) ?? [];
    for (const u of urlish) {
      const d = registrable(u);
      if (d) out.add(d);
    }
    const maybe = registrable(value);
    if (maybe && value.includes(".")) out.add(maybe);
  } else if (Array.isArray(value)) {
    for (const item of value) extractDomains(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) extractDomains(item, out);
  }
  return out;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    env[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return env;
}

export function envValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  // .dev.vars holds the worker's local secrets (CONTEXT_DEV_API_KEY et al).
  const devVars = loadDotEnv(join(ROOT, ".dev.vars"));
  if (devVars[name]) return devVars[name];
  const local = loadDotEnv(`${process.env.HOME ?? ""}/.config/connectors/secrets.env`);
  return local[name];
}

export type SurfaceLike = {
  slug: string;
  type: string;
  url?: string;
  spec?: string;
  command?: string;
  packages?: Array<{ identifier?: string }>;
};

export function readPriorSurfaces(existingDir: string | undefined, domain: string): SurfaceLike[] {
  if (!existingDir) return [];
  for (const name of [`${safeDomainFile(domain)}.json`, `${domain}.json`]) {
    const path = join(existingDir, name);
    if (!existsSync(path)) continue;
    const row = readJson<{ result?: { surfaces?: SurfaceLike[] }; surfaces?: SurfaceLike[] }>(path);
    return row.result?.surfaces ?? row.surfaces ?? [];
  }
  return [];
}

function normalizeCredentialFields(fields: unknown): unknown {
  if (!Array.isArray(fields)) return fields ?? undefined;
  return Object.fromEntries(
    fields
      .filter((field) => field && typeof field === "object" && typeof (field as { name?: unknown }).name === "string")
      .map((field) => {
        const { name, ...rest } = field as Record<string, unknown> & { name: string };
        return [name, rest];
      }),
  );
}

function stripNullOptionals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullOptionals).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value === null ? undefined : value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, stripNullOptionals(item)] as const)
      .filter(([, item]) => item !== undefined),
  );
}

function normalizeCredentials(credentials: unknown): Record<string, unknown> {
  if (Array.isArray(credentials)) {
    return Object.fromEntries(
      credentials
        .filter((credential) => credential && typeof credential === "object" && typeof (credential as { id?: unknown }).id === "string")
        .map((credential) => {
          const { id, fields, ...rest } = credential as Record<string, unknown> & { id: string; fields?: unknown };
          return [id, stripNullOptionals({ ...rest, fields: normalizeCredentialFields(fields) })];
        }),
    );
  }
  if (!credentials || typeof credentials !== "object") return {};
  return Object.fromEntries(
    Object.entries(credentials).map(([id, credential]) => {
      if (!credential || typeof credential !== "object") return [id, credential];
      const { fields, ...rest } = credential as Record<string, unknown> & { fields?: unknown };
      return [id, stripNullOptionals({ ...rest, fields: normalizeCredentialFields(fields) })];
    }),
  );
}

export function validateAndFinalize(
  domain: string,
  raw: unknown,
  existingDir?: string,
): { result: DiscoveryResult; collapses: DedupCollapse[] } {
  const value = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  value.domain = domain;
  const deduped = dedupSurfacesWithReport(value, domain);
  const next = deduped.result as Record<string, unknown>;
  next.version = 3;
  next.domain = domain;
  next.credentials = normalizeCredentials(next.credentials);
  const surfaces = Array.isArray(next.surfaces) ? (next.surfaces as Array<Record<string, unknown>>) : [];
  const assigned: SurfaceLike[] = [];
  for (const surface of surfaces) {
    if (typeof surface.slug !== "string" || !surface.slug) surface.slug = assignSlug(String(surface.name ?? "surface"), assigned);
    assigned.push(surface as SurfaceLike);
  }
  preserveSlugs(assigned, readPriorSurfaces(existingDir, domain));
  next.surfaces = assigned;
  return { result: Schema.decodeUnknownSync(DiscoveryResultSchema)(stripNullOptionals(next)), collapses: deduped.collapses };
}

export function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

export function run(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): void {
  const res = spawnSync(cmd, args, { cwd: opts?.cwd ?? ROOT, env: { ...process.env, ...opts?.env }, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

export function displaySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const fileDomain = (path: string): string => basename(path, ".json");
