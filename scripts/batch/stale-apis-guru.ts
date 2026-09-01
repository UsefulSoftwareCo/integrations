import { getFlag, getNumberFlag, hasFlag, mapLimit, parseArgs, readJson, ROOT, usage } from "./shared.ts";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export const DEFAULT_STALE_DAYS = 365;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_PARALLELISM = 8;
export const DEFAULT_OUT_FILE = "reports/stale-api-guru.json";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiGuruSpecLite {
  provider: string;
  service?: string | null;
  updated?: string;
  link?: string;
  origin?: string;
  swaggerUrl?: string;
}

export interface ApiGuruSpecsFile {
  specs: ApiGuruSpecLite[];
}

interface ProbeBase {
  kind: "spec" | "origin";
  url: string;
  status: "ok" | "error";
  httpStatus?: number;
  contentType: string | null;
  specLike: boolean;
  error?: string;
}

export interface StaleProbe extends ProbeBase {}

export interface StaleApiGuruEntry {
  provider: string;
  service?: string;
  domain: string;
  updated?: string;
  ageDays: number | null;
  reasons: string[];
  probes: StaleProbe[];
}

interface AnalyzeOptions {
  staleAfterDays: number;
  timeoutMs: number;
  parallelism: number;
  nowMs: number;
}

const HELP = `
Usage: bun scripts/batch/stale-apis-guru.ts --source file [options]

Scan apis.guru source rows for likely stale API definitions.

Options:
  --source path            Path to api-guru-openapi.json (default: sources/api-guru-openapi.json)
  --out path               Write stale candidates JSON summary (default: reports/stale-api-guru.json)
  --max-age-days number    Only flag entries older than this value (default: ${DEFAULT_STALE_DAYS})
  --timeout-ms number      Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --parallel number        Concurrent request limit (default: ${DEFAULT_PARALLELISM})
  --json                   Print JSON report to stdout
  --strict                 Exit non-zero if any stale entries are found
  --help                   Show this help
`;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function ageInDays(updated: string | undefined, nowMs: number): number | null {
  if (!updated) return null;
  const parsed = Date.parse(updated);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (nowMs - parsed) / (1000 * 60 * 60 * 24));
}

function isSpecLikely(head: string, contentType: string | null): boolean {
  const text = head.toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json") || ct.includes("yaml") || ct.includes("yml")) return true;
  return /["']openapi["']\s*[:=]/i.test(text) ||
    /["']swagger["']\s*[:=]/i.test(text) ||
    /\bopenapi:\s*/i.test(text) ||
    /\bswagger:\s*/i.test(text);
}

function readHeadChunk(response: Response, maxChars = 4000): Promise<string> {
  if (!response.body) return Promise.resolve("");
  const decoder = new TextDecoder();
  return response.body.getReader().read().then(({ value }) => {
    const chunk = value ? decoder.decode(value, { stream: true }) : "";
    return chunk.slice(0, maxChars);
  });
}

async function probeEndpoint(url: string, kind: StaleProbe["kind"], fetchImpl: FetchLike, timeoutMs: number): Promise<StaleProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
    });
    const head = await readHeadChunk(response);
    const contentType = response.headers.get("content-type");
    const ok = response.status >= 200 && response.status < 400;
    clearTimeout(timeout);
    return {
      kind,
      url,
      status: ok ? "ok" : "error",
      httpStatus: response.status,
      contentType,
      specLike: kind === "spec" ? isSpecLikely(head, contentType) : false,
    };
  } catch (error) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    return { kind, url, status: "error", contentType: null, specLike: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

export function analyzeStaleEntry(
  spec: ApiGuruSpecLite,
  probes: StaleProbe[],
  staleAfterDays: number,
  nowMs: number,
): { stale: boolean; entry?: StaleApiGuruEntry } {
  const reasons: string[] = [];
  const ageDays = ageInDays(spec.updated, nowMs);
  if (ageDays === null || ageDays < staleAfterDays) return { stale: false };

  const specTargets = probes.filter((probe) => probe.kind === "spec");
  if (specTargets.length === 0) return { stale: false };

  const specReachable = specTargets.some((probe) => probe.status === "ok" && probe.specLike);
  if (!specReachable) {
    reasons.push("no accessible OpenAPI/Swagger payload at declared spec endpoints");
  }

  if (reasons.length === 0) return { stale: false };
  return {
    stale: true,
    entry: {
      provider: spec.provider,
      service: spec.service ?? undefined,
      domain: spec.provider,
      updated: spec.updated,
      ageDays,
      reasons,
      probes,
    },
  };
}

export async function detectPotentiallyStaleApiGuruEntries(
  specs: readonly ApiGuruSpecLite[],
  fetchImpl: FetchLike = fetch,
  options: AnalyzeOptions,
): Promise<StaleApiGuruEntry[]> {
  const rows = specs.filter((spec) => isHttpUrl(spec.provider) === false);
  const results = await mapLimit(rows, options.parallelism, async (spec) => {
    const targets = [spec.swaggerUrl, spec.link].filter(isHttpUrl);
    const probes = await Promise.all(
      targets.map((url) => probeEndpoint(url, "spec", fetchImpl, options.timeoutMs)),
    );
    const outcome = analyzeStaleEntry(spec, probes, options.staleAfterDays, options.nowMs);
    return outcome.entry;
  });
  return results.filter((entry): entry is StaleApiGuruEntry => Boolean(entry)).sort((a, b) => b.ageDays - a.ageDays);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const source = getFlag(args, "source", join(ROOT, "sources", "api-guru-openapi.json"))!;
  const out = getFlag(args, "out", DEFAULT_OUT_FILE);
  const staleAfterDays = getNumberFlag(args, "max-age-days", DEFAULT_STALE_DAYS);
  const timeoutMs = getNumberFlag(args, "timeout-ms", DEFAULT_TIMEOUT_MS);
  const parallelism = getNumberFlag(args, "parallel", DEFAULT_PARALLELISM);
  const strict = hasFlag(args, "strict");
  const outputJson = hasFlag(args, "json");

  const payload = readJson<ApiGuruSpecsFile>(source);
  const specs = payload.specs ?? [];
  const nowMs = Date.now();
  const staleEntries = await detectPotentiallyStaleApiGuruEntries(specs, fetch, {
    staleAfterDays,
    timeoutMs,
    parallelism,
    nowMs,
  });

  if (outputJson) {
    console.log(JSON.stringify({ staleEntries, scanned: specs.length, staleAfterDays }, null, 2));
  } else {
    console.log(`scanned ${specs.length} API.guru entries; stale candidates: ${staleEntries.length}`);
    for (const entry of staleEntries) {
      const ageDays = entry.ageDays === null ? "unknown" : `${Math.round(entry.ageDays)}d`;
      const service = entry.service ? ` (${entry.service})` : "";
      const summary = [entry.provider, service, `age:${ageDays}`, ...(entry.updated ? [`updated:${entry.updated}`] : [])].filter(Boolean);
      console.log(`- ${summary.join(" ")} -> ${entry.reasons.join("; ")}`);
    }
  }

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(staleEntries, null, 2)}\n`);
    console.log(`wrote stale analysis to ${out}`);
  }

  if (strict && staleEntries.length > 0) {
    process.exit(1);
  }
}

if (import.meta.main) await main();
