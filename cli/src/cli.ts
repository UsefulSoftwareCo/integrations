#!/usr/bin/env node
/**
 * integrations - the CLI for integrations.sh.
 *
 * The command surface is derived from <base>/openapi.json. Set
 * INTEGRATIONS_BASE to point at another host instead of integrations.sh.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import packageJson from "../package.json" with { type: "json" };
import {
  defaultValue,
  deriveOps,
  entryArray,
  enumValues,
  parseOperationArgs,
  parseRegistryEntries,
  schemaType,
  type Entry,
  type Op,
  type OpenApiSpec,
  type Param,
} from "./core";
import skillMarkdown from "./skill.md" with { type: "text" };

const BASE = (process.env.INTEGRATIONS_BASE ?? "https://integrations.sh").replace(/\/$/, "");
const SPEC_URL = `${BASE}/openapi.json`;
const SPEC_CACHE = join(tmpdir(), "integrations-sh-spec.json");
const UPDATE_STATE = join(tmpdir(), "integrations-sh-update.json");
const SPEC_TTL_MS = 60 * 60 * 1000;
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DISCOVER_FETCH_TIMEOUT_MS = 120_000;
const VERSION = packageJson.version;
const MCP_URL = "https://integrations.sh/mcp";

type Kind = "mcp" | "openapi" | "graphql" | "cli";

interface SpecCache {
  base: string;
  fetchedAt: number;
  maxAgeMs: number;
  etag?: string;
  spec: OpenApiSpec;
}

interface Group {
  domain: string;
  total: number;
  kinds: Set<string>;
  records: Entry[];
  pop: number;
}

interface Flags {
  noCache: boolean;
  json: boolean;
}

interface ParsedArgs {
  args: string[];
  flags: Flags;
}

const KIND_ORDER: Kind[] = ["mcp", "openapi", "graphql", "cli"];
const TAG: Record<Kind, string> = { mcp: "mcp", openapi: "rest", graphql: "graphql", cli: "cli" };
const SECTION: Record<Kind, string> = {
  mcp: "MCP SERVERS",
  openapi: "REST · OPENAPI",
  graphql: "GRAPHQL",
  cli: "CLI",
};
const BUILTIN_COMMANDS = [
  { cmd: "skill", summary: "Print the integrations.sh agent skill markdown" },
  { cmd: "mcp", summary: "Print hosted MCP connection instructions" },
];
const MCP_INFO = {
  url: MCP_URL,
  transport: "streamable-http",
  tools: ["detect", "discover"],
};

// tiny ansi (restrained, TTY-only)
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

let jsonRequested = false;

function isJsonOutput(): boolean {
  return jsonRequested || !process.stdout.isTTY;
}

function printJsonDocument(value: unknown) {
  process.stdout.write(`${JSON.stringify(value ?? null)}\n`);
}

function fail(msg: string): never {
  throw new CliError(msg);
}

function exitWithError(msg: string): never {
  if (isJsonOutput()) {
    printJsonDocument({ error: msg });
  } else {
    process.stderr.write(`integrations: ${msg}\n`);
  }
  process.exit(1);
}

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);

function parseGlobals(argv: string[]): ParsedArgs {
  const args: string[] = [];
  const flags: Flags = { noCache: false, json: false };

  for (const arg of argv) {
    if (arg === "--no-cache") flags.noCache = true;
    else if (arg === "--json") flags.json = true;
    else args.push(arg);
  }

  return { args, flags };
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(file: string, data: unknown) {
  try {
    await writeFile(file, JSON.stringify(data), "utf8");
  } catch {
    // Cache writes should never make the CLI fail.
  }
}

async function fetchUrl(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();

  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseMaxAge(cacheControl: string | null): number {
  const match = cacheControl?.match(/(?:^|,\s*)max-age=(\d+)/i);
  if (!match) return SPEC_TTL_MS;
  return Math.min(Number(match[1]) * 1000, SPEC_TTL_MS);
}

function isFresh(cache: SpecCache): boolean {
  return cache.base === BASE && Date.now() - cache.fetchedAt < cache.maxAgeMs;
}

async function loadSpec(noCache: boolean, soft = false): Promise<OpenApiSpec | undefined> {
  const cached = noCache ? undefined : await readJsonFile<SpecCache>(SPEC_CACHE);
  if (cached && isFresh(cached)) return cached.spec;

  const headers: Record<string, string> = { accept: "application/json" };
  if (cached?.base === BASE && cached.etag && !noCache) headers["if-none-match"] = cached.etag;

  try {
    const res = await fetchUrl(SPEC_URL, { headers });
    if (res.status === 304 && cached?.base === BASE) {
      const nextCache = { ...cached, fetchedAt: Date.now(), maxAgeMs: parseMaxAge(res.headers.get("cache-control")) };
      await writeJsonFile(SPEC_CACHE, nextCache);
      return cached.spec;
    }

    if (!res.ok) {
      if (cached?.base === BASE && !noCache) return cached.spec;
      if (soft) return undefined;
      return fail(`${SPEC_URL} returned ${res.status}`);
    }

    const spec = (await res.json()) as OpenApiSpec;
    const cache: SpecCache = {
      base: BASE,
      fetchedAt: Date.now(),
      maxAgeMs: parseMaxAge(res.headers.get("cache-control")),
      etag: res.headers.get("etag") ?? undefined,
      spec,
    };
    await writeJsonFile(SPEC_CACHE, cache);
    return spec;
  } catch {
    if (cached?.base === BASE && !noCache) return cached.spec;
    if (soft) return undefined;
    return fail(`could not reach ${SPEC_URL}`);
  }
}

async function cachedSpecVersion(noCache: boolean): Promise<string | undefined> {
  const spec = await loadSpec(noCache, true);
  return spec?.info?.version;
}

function schemaMeta(spec: OpenApiSpec, param: Param): string {
  const parts: string[] = [];
  const values = enumValues(spec, param.schema);
  const fallback = defaultValue(spec, param.schema);
  if (values.length) parts.push(`one of ${values.map(String).join(", ")}`);
  if (fallback !== undefined) parts.push(`default ${String(fallback)}`);
  return parts.length ? dim(` (${parts.join("; ")})`) : "";
}

function paramPayload(spec: OpenApiSpec, param: Param) {
  return {
    name: param.name,
    flag: param.flag,
    in: param.in,
    required: param.required,
    description: param.description,
    type: schemaType(spec, param.schema),
    enum: enumValues(spec, param.schema),
    default: defaultValue(spec, param.schema),
  };
}

function opPayload(spec: OpenApiSpec, op: Op) {
  return {
    id: op.id,
    command: op.cmd,
    method: op.method,
    path: op.path,
    summary: op.summary,
    description: op.description,
    usage: ["integrations", op.cmd, ...op.pathParams.map((param) => `<${param.name}>`)].join(" "),
    pathParams: op.pathParams.map((param) => paramPayload(spec, param)),
    queryParams: op.queryParams.map((param) => paramPayload(spec, param)),
    hasBody: op.hasBody,
    bodyRequired: op.bodyRequired,
  };
}

function rootHelpPayload(spec: OpenApiSpec, ops: Op[]) {
  return {
    title: spec.info?.title ?? "integrations",
    apiVersion: spec.info?.version ?? null,
    description: spec.info?.description ?? "",
    usage: "integrations <command> [args] [--flags]",
    commands: [
      ...BUILTIN_COMMANDS,
      ...ops.map((op) => ({ cmd: op.cmd, summary: op.summary || "API operation", operationId: op.id })),
    ],
    options: ["--json", "--no-cache", "--version"],
    env: { INTEGRATIONS_BASE: BASE },
  };
}

function printRootHelp(spec: OpenApiSpec, ops: Op[]) {
  if (isJsonOutput()) {
    printJsonDocument(rootHelpPayload(spec, ops));
    return;
  }

  const title = spec.info?.title ?? "integrations";
  const apiVersion = spec.info?.version ? `api ${spec.info.version}` : "api unknown";

  process.stdout.write(`${bold(title)} ${dim(apiVersion)}\n`);
  if (spec.info?.description) process.stdout.write(`${clip(spec.info.description, 120)}\n`);
  process.stdout.write("\nusage:\n");
  process.stdout.write(`  ${bold("integrations <command>")} ${dim("[args] [--flags]")}\n\n`);
  process.stdout.write("commands:\n");
  for (const command of BUILTIN_COMMANDS) {
    const sig = `integrations ${command.cmd}`;
    process.stdout.write(`  ${bold(sig.padEnd(34))} ${dim(command.summary)}\n`);
  }
  for (const op of ops) {
    const sig = `integrations ${op.cmd} ${op.pathParams.map((param) => `<${param.name}>`).join(" ")}`.trim();
    process.stdout.write(`  ${bold(sig.padEnd(34))} ${dim(clip(op.summary || "API operation", 60))}\n`);
  }
  process.stdout.write("\noptions:\n");
  process.stdout.write("  --json       print raw JSON\n");
  process.stdout.write("  --no-cache   bypass the OpenAPI cache\n");
  process.stdout.write("  --version    print CLI and API versions\n");
  process.stdout.write("\nenv:\n");
  process.stdout.write(`  INTEGRATIONS_BASE   API host (default ${BASE})\n`);
}

function printCommandHelp(spec: OpenApiSpec, op: Op) {
  if (isJsonOutput()) {
    printJsonDocument(opPayload(spec, op));
    return;
  }

  const args = op.pathParams.map((param) => `<${param.name}>`).join(" ");
  const flags = op.queryParams.map((param) => `--${param.flag}`).join(" ");
  const data = op.hasBody ? "--data '<json>'" : "";
  const usage = ["integrations", op.cmd, args, flags, data].filter(Boolean).join(" ");

  process.stdout.write(`${bold(op.cmd)} ${dim(`${op.method} ${op.path}`)}\n\n`);
  if (op.description) process.stdout.write(`${op.description}\n\n`);
  process.stdout.write("usage:\n");
  process.stdout.write(`  ${usage}\n`);

  if (op.pathParams.length || op.queryParams.length || op.hasBody) {
    process.stdout.write("\nparameters:\n");
    for (const param of op.pathParams) {
      process.stdout.write(`  <${param.name}>${param.description ? `  ${param.description}` : ""}${schemaMeta(spec, param)}\n`);
    }
    for (const param of op.queryParams) {
      const required = param.required ? "required" : "optional";
      process.stdout.write(`  --${param.flag} <${param.name}>  ${dim(required)}${param.description ? `  ${param.description}` : ""}${schemaMeta(spec, param)}\n`);
    }
    if (op.hasBody) {
      const required = op.bodyRequired ? "required" : "optional";
      process.stdout.write(`  --data <json>  ${dim(required)} request body passthrough\n`);
    }
  }
}

function buildUrl(op: Op, positionals: string[], query: Map<string, string[]>): string {
  const pathValues = new Map<string, string>();
  op.pathParams.forEach((param, index) => pathValues.set(param.name, positionals[index] ?? ""));

  const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(pathValues.get(name) ?? ""));
  const url = new URL(`${BASE}${path}`);
  for (const [name, values] of query) {
    for (const value of values) url.searchParams.append(name, value);
  }
  return url.toString();
}

async function invokeOp(spec: OpenApiSpec, op: Op, argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printCommandHelp(spec, op);
    return;
  }

  const parsed = parseOperationArgs(spec, op, argv);
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = { method: op.method, headers };
  if (parsed.data !== undefined) {
    headers["content-type"] = "application/json";
    init.body = parsed.data;
  }

  const url = buildUrl(op, parsed.positionals, parsed.query);
  const isDiscover = operationRole(op) === "discover";
  if (isDiscover && !isJsonOutput()) {
    process.stderr.write(`discovering ${operationDomain(op, parsed.positionals, parsed.query) ?? "domain"} — this can take up to a minute\n`);
  }

  let res: Response;
  try {
    res = await fetchUrl(url, init, isDiscover ? DISCOVER_FETCH_TIMEOUT_MS : DEFAULT_FETCH_TIMEOUT_MS);
  } catch {
    return fail(`could not reach ${url}`);
  }
  const text = await res.text();
  if (res.status === 429 && isDiscover) {
    fail(`discover is rate-limited to 3 requests per 60s per IP; try again shortly`);
  }
  if (!res.ok) fail(`${op.cmd} -> ${res.status}: ${clip(text, 200)}`);

  const type = res.headers.get("content-type") ?? "";
  if (isJsonOutput()) {
    if (!type.includes("json")) {
      printJsonDocument({ body: text, contentType: type || undefined });
      return;
    }
    try {
      printJsonDocument(JSON.parse(text));
    } catch {
      fail(`${op.cmd} returned invalid JSON`);
    }
    return;
  }

  if (!type.includes("json")) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }

  renderJson(JSON.parse(text));
}

function operationRole(op: Op): string {
  const parts = op.id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return parts[parts.length - 1] ?? op.cmd;
}

function findRoleOp(ops: Op[], role: string): Op | undefined {
  return ops.find((op) => op.cmd === role)
    ?? ops.find((op) => operationRole(op) === role)
    ?? ops.find((op) => op.path.toLowerCase().includes(`/${role}`));
}

function argvForSearchAlias(op: Op, argv: string[]): string[] {
  if (argv.some((arg) => arg.startsWith("--"))) return argv;
  if (op.pathParams.length > 0) return argv;
  const param = op.queryParams.find((item) => item.required)
    ?? op.queryParams.find((item) => ["q", "query", "search", "term"].includes(item.name.toLowerCase()));
  if (!param || argv.length === 0) return argv;
  return [`--${param.flag}`, argv.join(" ")];
}

function argvForDomainAlias(op: Op, domain: string): string[] {
  if (op.pathParams.length > 0) return [domain];
  const param = op.queryParams.find((item) => item.required)
    ?? op.queryParams.find((item) => ["domain", "url", "host"].includes(item.name.toLowerCase()));
  return param ? [`--${param.flag}`, domain] : [domain];
}

function operationDomain(op: Op, positionals: string[], query: Map<string, string[]>): string | undefined {
  const domainIndex = op.pathParams.findIndex((param) => param.name.toLowerCase() === "domain");
  if (domainIndex !== -1) return positionals[domainIndex];
  return query.get("domain")?.[0] ?? positionals[0];
}

function groupByDomain(records: Entry[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const r of records) {
    const domain = r.domain || r.slug;
    if (!domain) continue;
    let group = groups.get(domain);
    if (!group) {
      group = { domain, total: 0, kinds: new Set(), records: [], pop: 0 };
      groups.set(domain, group);
    }
    group.total++;
    group.kinds.add(r.kind);
    group.records.push(r);
    group.pop = Math.max(group.pop, r.popularity ?? 0);
  }
  return groups;
}

const formatsOf = (g: Group) => KIND_ORDER.filter((kind) => g.kinds.has(kind)).map((kind) => TAG[kind]).join(" · ");
const byPop = (a: Group, b: Group) => b.pop - a.pop || b.total - a.total || a.domain.localeCompare(b.domain);

async function loadRegistry(): Promise<Entry[]> {
  let res: Response;
  try {
    res = await fetchUrl(`${BASE}/api.json`, { headers: { accept: "application/json" } });
  } catch {
    return fail(`could not reach ${BASE}/api.json`);
  }
  if (!res.ok) return fail(`${BASE}/api.json returned ${res.status}`);
  return parseRegistryEntries(await res.json(), `${BASE}/api.json response`);
}

function serializeGroup(group: Group) {
  return {
    domain: group.domain,
    total: group.total,
    formats: KIND_ORDER.filter((kind) => group.kinds.has(kind)).map((kind) => TAG[kind]),
    records: group.records,
  };
}

function renderSearchGroups(groups: Group[]) {
  if (groups.length === 0) {
    process.stdout.write(dim("no matches\n"));
    return;
  }

  const limit = 30;
  const shown = groups.slice(0, limit);
  const pad = Math.min(28, Math.max(...shown.map((group) => group.domain.length)));
  for (const group of shown) {
    const desc = group.records.find((record) => record.description)?.description ?? "";
    process.stdout.write(`${bold(group.domain.padEnd(pad))}  ${dim(formatsOf(group).padEnd(22))}  ${dim(clip(desc, 64))}\n`);
  }
  if (groups.length > limit) process.stdout.write(dim(`\n... ${groups.length - limit} more - narrow your query\n`));
}

function renderDomainGroup(group: Group) {
  process.stdout.write(`\n${bold(group.domain)} ${dim(`- ${group.total} integration${group.total === 1 ? "" : "s"}`)}\n`);
  for (const kind of KIND_ORDER) {
    const items = group.records
      .filter((record) => record.kind === kind)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.name.localeCompare(b.name));
    if (items.length === 0) continue;
    process.stdout.write(`\n${dim(SECTION[kind])}\n`);
    for (const item of items) {
      const desc = item.description ? dim(`  ${clip(item.description, 60)}`) : "";
      process.stdout.write(`  ${item.name}${desc}  ${dim(`${BASE}/${item.kind}/${item.slug}/`)}\n`);
    }
  }
  process.stdout.write("\n");
}

async function fallbackSearch(query: string) {
  if (!query) fail("usage: integrations search <query>");
  const q = query.toLowerCase();
  const records = await loadRegistry();
  const groups = [...groupByDomain(records).values()].filter((group) =>
    group.domain.toLowerCase().includes(q)
    || group.records.some((record) =>
      record.name.toLowerCase().includes(q)
      || (record.description ?? "").toLowerCase().includes(q),
    ),
  ).sort(byPop);

  if (isJsonOutput()) {
    printJsonDocument(groups.map(serializeGroup));
    return;
  }

  renderSearchGroups(groups);
}

async function fallbackDomain(term: string) {
  const t = term.toLowerCase();
  const records = await loadRegistry();
  const groups = groupByDomain(records);

  let group = groups.get(term);
  if (!group) {
    const candidates = [...groups.values()].filter((item) => item.domain.toLowerCase().includes(t)).sort(byPop);
    if (candidates.length === 0) fail(`no domain matching "${term}"`);
    if (candidates.length > 1 && candidates[0]!.domain.toLowerCase() !== t) {
      if (isJsonOutput()) {
        printJsonDocument(candidates.slice(0, 8).map(serializeGroup));
        return;
      }
      process.stdout.write(dim("did you mean:\n"));
      for (const candidate of candidates.slice(0, 8)) process.stdout.write(`  ${candidate.domain}  ${dim(formatsOf(candidate))}\n`);
      return;
    }
    group = candidates[0]!;
  }

  if (isJsonOutput()) {
    printJsonDocument(serializeGroup(group));
    return;
  }

  renderDomainGroup(group);
}

function findEntryArray(value: unknown): Entry[] | undefined {
  const direct = entryArray(value);
  if (direct) return direct;
  if (typeof value !== "object" || value === null) return undefined;
  for (const key of ["records", "items", "results", "data", "surfaces"]) {
    const found = entryArray((value as Record<string, unknown>)[key]);
    if (found) return found;
  }
  return undefined;
}

function renderJson(value: unknown) {
  const entries = findEntryArray(value);
  if (entries) {
    const groups = [...groupByDomain(entries).values()].sort(byPop);
    if (groups.length === 1) renderDomainGroup(groups[0]!);
    else renderSearchGroups(groups);
    return;
  }

  process.stdout.write(`${renderValue(value).join("\n")}\n`);
}

function label(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
}

function renderScalar(value: unknown): string {
  if (value === null) return dim("null");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderValue(value: unknown, indent = 0): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${dim("empty")}`];
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return value.map((item) => `${pad}- ${renderScalar(item)}`);
    }
    return value.flatMap((item, index) => [
      `${pad}${dim(`#${index + 1}`)}`,
      ...renderValue(item, indent + 2),
    ]);
  }

  if (typeof value !== "object" || value === null) return [`${pad}${renderScalar(value)}`];

  const lines: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(item) || (typeof item === "object" && item !== null)) {
      lines.push(`${pad}${dim(label(key).toUpperCase())}`);
      lines.push(...renderValue(item, indent + 2));
    } else {
      lines.push(`${pad}${bold(label(key))}: ${renderScalar(item)}`);
    }
  }
  return lines.length ? lines : [`${pad}${dim("empty")}`];
}

async function maybePrintUpdateNudge() {
  if (isJsonOutput() || process.env.CI) return;

  const state = await readJsonFile<{ checkedAt?: number }>(UPDATE_STATE);
  if (state?.checkedAt && Date.now() - state.checkedAt < UPDATE_TTL_MS) return;
  await writeJsonFile(UPDATE_STATE, { checkedAt: Date.now() });

  try {
    const res = await fetchUrl("https://registry.npmjs.org/integrations", {
      headers: { accept: "application/json" },
    }, 1000);
    if (!res.ok) return;
    const body = await res.json() as { "dist-tags"?: { latest?: string } };
    const latest = body["dist-tags"]?.latest;
    if (latest && latest !== VERSION) {
      process.stderr.write(dim(`update available: ${VERSION} → ${latest} (npm i -g integrations)\n`));
    }
  } catch {
    // Update checks are opportunistic.
  }
}

async function run() {
  const parsed = parseGlobals(process.argv.slice(2));
  jsonRequested = parsed.flags.json;
  const [cmd, ...rest] = parsed.args;

  if (cmd === "--version" || cmd === "-v") {
    const apiVersion = await cachedSpecVersion(parsed.flags.noCache);
    if (isJsonOutput()) printJsonDocument({ version: VERSION, apiVersion: apiVersion ?? null });
    else process.stdout.write(`${VERSION} (api ${apiVersion ?? "unknown"})\n`);
    await maybePrintUpdateNudge();
    return;
  }

  if (cmd === "help" && rest[0] && printBuiltinHelp(rest[0])) return;
  if (cmd === "skill") {
    if (rest.includes("--help") || rest.includes("-h")) {
      printBuiltinHelp("skill");
      return;
    }
    if (rest.length) fail(`unexpected argument "${rest[0]}"`);
    printSkill();
    return;
  }
  if (cmd === "mcp") {
    if (rest.includes("--help") || rest.includes("-h")) {
      printBuiltinHelp("mcp");
      return;
    }
    if (rest.length) fail(`unexpected argument "${rest[0]}"`);
    printMcp();
    return;
  }

  const loadedSpec = await loadSpec(parsed.flags.noCache);
  if (!loadedSpec) fail(`could not load ${SPEC_URL}`);
  const spec = loadedSpec;
  const ops = deriveOps(spec);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    if (cmd === "help" && rest[0]) {
      const op = ops.find((item) => item.cmd === rest[0]);
      if (!op) fail(`unknown command "${rest[0]}"`);
      printCommandHelp(spec, op);
    } else {
      printRootHelp(spec, ops);
    }
    await maybePrintUpdateNudge();
    return;
  }

  if (cmd === "search") {
    const searchOp = findRoleOp(ops, "search");
    if (searchOp) await invokeOp(spec, searchOp, argvForSearchAlias(searchOp, rest));
    else await fallbackSearch(rest.join(" "));
    await maybePrintUpdateNudge();
    return;
  }

  const op = ops.find((item) => item.cmd === cmd);
  if (op) {
    await invokeOp(spec, op, rest);
    await maybePrintUpdateNudge();
    return;
  }

  const surfaceOp = findRoleOp(ops, "surface");
  try {
    if (surfaceOp) await invokeOp(spec, surfaceOp, argvForDomainAlias(surfaceOp, cmd));
    else await fallbackDomain(cmd);
  } catch (error) {
    if (!looksLikeDomain(cmd)) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`unknown command "${cmd}" (and no domain match; run "integrations help"): ${detail}`);
    }
    throw error;
  }
  await maybePrintUpdateNudge();
}

function looksLikeDomain(value: string): boolean {
  return value.includes(".") && !value.startsWith(".") && !value.endsWith(".");
}

function builtinHelpPayload(cmd: string) {
  if (cmd === "skill") {
    return {
      command: "skill",
      summary: "Print the integrations.sh agent skill markdown",
      usage: "integrations skill [--json]",
      json: { name: "integrations-sh", content: "<full markdown>" },
    };
  }
  if (cmd === "mcp") {
    return {
      command: "mcp",
      summary: "Print hosted MCP connection instructions",
      usage: "integrations mcp [--json]",
      json: MCP_INFO,
    };
  }
  return undefined;
}

function printBuiltinHelp(cmd: string): boolean {
  const payload = builtinHelpPayload(cmd);
  if (!payload) return false;
  if (isJsonOutput()) {
    printJsonDocument(payload);
    return true;
  }
  process.stdout.write(`${bold(payload.command)}\n\n`);
  process.stdout.write(`${payload.summary}\n\n`);
  process.stdout.write("usage:\n");
  process.stdout.write(`  ${payload.usage}\n`);
  return true;
}

function printSkill() {
  if (jsonRequested) {
    printJsonDocument({ name: "integrations-sh", content: skillMarkdown });
    return;
  }
  process.stdout.write(skillMarkdown.endsWith("\n") ? skillMarkdown : `${skillMarkdown}\n`);
}

function printMcp() {
  if (isJsonOutput()) {
    printJsonDocument(MCP_INFO);
    return;
  }

  process.stdout.write("integrations.sh MCP\n\n");
  process.stdout.write(`url: ${MCP_URL}\n`);
  process.stdout.write("transport: streamable-http\n");
  process.stdout.write("tools: detect, discover\n\n");
  process.stdout.write("Claude Code:\n");
  process.stdout.write(`  claude mcp add --transport http integrations ${MCP_URL}\n\n`);
  process.stdout.write("Generic config:\n");
  process.stdout.write(`${JSON.stringify({ mcpServers: { integrations: { transport: "streamable-http", url: MCP_URL } } }, null, 2)}\n`);
}

run().catch((error) => exitWithError(error?.message ?? String(error)));
