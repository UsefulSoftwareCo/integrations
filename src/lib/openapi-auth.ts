/**
 * How to authenticate an OpenAPI surface, as the feed publishes it.
 *
 * Three sources, in falling confidence:
 *   curated  — a hand-verified `curated/*.json` interface
 *   spec     — the definition's own `securitySchemes` (summarized offline by
 *              `scripts/extract-openapi-auth.ts` into output/openapi-auth.json)
 *   registry — integrations.sh's own per-domain auth data (`registry-auth.json`)
 *
 * The rule throughout: publish auth only when it is complete and unambiguous.
 * A client treats a missing or partial `auth` as "ask the user", so a wrong
 * guess costs far more than an omission.
 */

export type FeedAuthKind = "none" | "api_key" | "token" | "basic" | "oauth";

export interface FeedAuth {
  kind: FeedAuthKind;
  /** One header template, e.g. "Authorization: Bearer {token}". */
  header?: string;
  /** Query parameter name carrying the single credential. */
  query?: string;
  /** Key of the spec's securitySchemes this credential fills. */
  scheme?: string;
  oauth?: { authorizationUrl: string; tokenUrl: string };
  note?: string;
  source: "spec" | "curated" | "registry";
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec summary
// ─────────────────────────────────────────────────────────────────────────────

/** One security scheme, reduced to what decides how a credential is sent. */
export type SchemeSummary =
  | { key: string; type: "apiKey"; in: "header" | "query" | "cookie"; name: string; bearerHint?: boolean }
  | { key: string; type: "bearer" }
  | { key: string; type: "basic" }
  | { key: string; type: "oauth2"; authorizationUrl?: string; tokenUrl?: string }
  | { key: string; type: "unsupported"; detail: string };

export interface SpecAuthSummary {
  /** Schemes the document requires (globally or per operation). When the
   *  document references none, every defined scheme, with `referenced: false`. */
  schemes: SchemeSummary[];
  referenced: boolean;
  /** Every scheme the document references (or defines, when it references
   *  none), whether or not it can stand alone. A curated record uses these
   *  to find the scheme carrying its own, already-chosen credential. */
  declared: SchemeSummary[];
  /** Some requirement needs several schemes at once (key + secret pairs). */
  combined?: boolean;
  /** Global `security: []` and no operation requires a scheme. */
  public?: boolean;
  /** Every server needs a per-tenant host (a templated or placeholder host). */
  tenantHost?: boolean;
  /** No absolute server URL, and the spec is hosted somewhere that is not the
   *  API (a mirror), so the base URL cannot be derived. */
  noServer?: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Hosts that mirror third-party specs; a relative server URL resolved
 *  against them would point at the mirror, not the API. */
const SPEC_MIRROR_HOSTS = [
  "api.apis.guru",
  "raw.githubusercontent.com",
  "github.com",
  "gist.githubusercontent.com",
  "app.stainless.com",
  "integrations.sh",
];

const PLACEHOLDER_HOST =
  /(^|\.)(example\.(com|org|net)|localhost|local|internal|127\.0\.0\.1|0\.0\.0\.0)$|your[-_]?(domain|host|server|instance|company|subdomain|site|account)|\{|<|\[/i;

function schemeSummary(key: string, raw: unknown, swagger2: boolean): SchemeSummary {
  if (!isObject(raw)) return { key, type: "unsupported", detail: "not an object" };
  const type = str(raw.type)?.toLowerCase();
  if (type === "apikey") {
    const where = str(raw.in)?.toLowerCase();
    const name = str(raw.name);
    if (!name || (where !== "header" && where !== "query" && where !== "cookie")) {
      return { key, type: "unsupported", detail: "apiKey without name/in" };
    }
    // Request signing (AWS SigV4 and the like) declares itself as an apiKey
    // in Authorization; no static credential can fill it.
    if (raw["x-amazon-apigateway-authtype"] !== undefined || /signature/i.test(`${name} ${str(raw.description) ?? ""}`)) {
      return { key, type: "unsupported", detail: "request signing" };
    }
    if (where === "header" && name.toLowerCase() === "cookie") return { key, type: "unsupported", detail: "cookie header" };
    const bearerHint =
      where === "header" && name.toLowerCase() === "authorization" && /bearer/i.test(str(raw.description) ?? "");
    return { key, type: "apiKey", in: where, name, ...(bearerHint ? { bearerHint } : {}) };
  }
  if (type === "basic") return { key, type: "basic" };
  if (type === "http") {
    const scheme = str(raw.scheme)?.toLowerCase();
    if (scheme === "bearer") return { key, type: "bearer" };
    if (scheme === "basic") return { key, type: "basic" };
    return { key, type: "unsupported", detail: `http ${scheme ?? "?"}` };
  }
  if (type === "oauth2") {
    if (swagger2) {
      const flow = str(raw.flow);
      if (flow === "accessCode") {
        return { key, type: "oauth2", authorizationUrl: str(raw.authorizationUrl), tokenUrl: str(raw.tokenUrl) };
      }
      return { key, type: "oauth2", ...(str(raw.authorizationUrl) ? { authorizationUrl: str(raw.authorizationUrl) } : {}) };
    }
    const flows = isObject(raw.flows) ? raw.flows : {};
    const code = isObject(flows.authorizationCode) ? flows.authorizationCode : undefined;
    if (code) return { key, type: "oauth2", authorizationUrl: str(code.authorizationUrl), tokenUrl: str(code.tokenUrl) };
    const implicit = isObject(flows.implicit) ? flows.implicit : undefined;
    return { key, type: "oauth2", ...(implicit && str(implicit.authorizationUrl) ? { authorizationUrl: str(implicit.authorizationUrl) } : {}) };
  }
  return { key, type: "unsupported", detail: type ?? "no type" };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function serverHosts(doc: Json): { hosts: string[]; relative: boolean } {
  if (typeof doc.swagger === "string") {
    const host = str(doc.host);
    return host ? { hosts: [host], relative: false } : { hosts: [], relative: true };
  }
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isObject) : [];
  const hosts: string[] = [];
  let relative = servers.length === 0;
  for (const s of servers) {
    const url = str(s.url);
    if (!url) continue;
    const vars = isObject(s.variables) ? s.variables : {};
    // A variable with a real default and a fixed enum (region pickers) still
    // yields a usable host; a free-form variable in the host does not.
    const hostPart = url.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
    let host = hostPart;
    for (const [name, def] of Object.entries(vars)) {
      if (!hostPart.includes(`{${name}}`)) continue;
      const fixed = isObject(def) && Array.isArray(def.enum) && def.enum.length > 0 ? str(def.default) : undefined;
      host = fixed ? host.replaceAll(`{${name}}`, fixed) : host;
    }
    if (!/^[a-z]+:\/\//i.test(url)) {
      relative = true;
      continue;
    }
    hosts.push(host);
  }
  return { hosts, relative };
}

/** Version of `slimSpec`'s output; cached slices of another version are
 *  re-fetched. */
export const SLIM_VERSION = 3;

/**
 * The parts of a spec that decide its authentication, small enough to cache
 * in git: version marker, servers/host, the security schemes (scopes
 * dropped), global security, and each distinct effective operation security
 * list with the number of operations that use it.
 * `summarizeSpecAuth` gives the same answer for the slim and the full
 * document, so the rules can change without re-fetching every spec.
 */
export function slimSpec(doc: unknown): Json {
  // Bump SLIM_VERSION whenever this keeps different fields.
  if (!isObject(doc)) return {};
  const swagger2 = typeof doc.swagger === "string";
  const trimScheme = (raw: unknown): unknown => {
    if (!isObject(raw)) return raw;
    const out: Json = {};
    for (const k of ["type", "in", "name", "scheme", "flow", "authorizationUrl", "tokenUrl"]) {
      if (raw[k] !== undefined) out[k] = raw[k];
    }
    // Only the description's signals survive: a Bearer prefix, or signing.
    const description = str(raw.description) ?? "";
    const signals = [/bearer/i.test(description) && "Bearer", /signature/i.test(description) && "Signature"].filter(Boolean);
    if (signals.length) out.description = signals.join(" ");
    if (raw["x-amazon-apigateway-authtype"] !== undefined) out["x-amazon-apigateway-authtype"] = raw["x-amazon-apigateway-authtype"];
    if (isObject(raw.flows)) {
      const flows: Json = {};
      for (const [name, flow] of Object.entries(raw.flows)) {
        if (!isObject(flow)) continue;
        flows[name] = {
          ...(flow.authorizationUrl !== undefined ? { authorizationUrl: flow.authorizationUrl } : {}),
          ...(flow.tokenUrl !== undefined ? { tokenUrl: flow.tokenUrl } : {}),
        };
      }
      out.flows = flows;
    }
    return out;
  };
  const trimAll = (defs: unknown): Json =>
    isObject(defs) ? Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, trimScheme(v)])) : {};
  const keysOnly = (list: unknown[]): Json[] =>
    list.filter(isObject).map((r) => Object.fromEntries(Object.keys(r).map((k) => [k, []])));

  const slimPaths: Json = {};
  effectiveSecurity(doc).forEach(({ list, count }, i) => {
    slimPaths[`/_${i}`] = { get: { security: keysOnly(list), "x-ops": count } };
  });

  return {
    ...(swagger2 ? { swagger: doc.swagger } : { openapi: doc.openapi ?? "3" }),
    ...(swagger2 && doc.host !== undefined ? { host: doc.host } : {}),
    ...(!swagger2 && Array.isArray(doc.servers)
      ? {
          servers: doc.servers.filter(isObject).map((s) => ({
            url: s.url,
            ...(isObject(s.variables)
              ? {
                  variables: Object.fromEntries(
                    Object.entries(s.variables).map(([k, v]) => [
                      k,
                      isObject(v) ? { default: v.default, ...(Array.isArray(v.enum) ? { enum: v.enum } : {}) } : v,
                    ]),
                  ),
                }
              : {}),
          })),
        }
      : {}),
    ...(Array.isArray(doc.security) ? { security: keysOnly(doc.security) } : {}),
    ...(swagger2
      ? { securityDefinitions: trimAll(doc.securityDefinitions) }
      : { components: { securitySchemes: trimAll(isObject(doc.components) ? doc.components.securitySchemes : undefined) } }),
    paths: slimPaths,
  };
}

/** Share of auth-requiring operations a scheme must satisfy on its own to
 *  count as the API's credential. */
const SINGLE_CREDENTIAL_COVERAGE = 0.9;

/** Each distinct effective security list (an operation's own `security`, else
 *  the document's), with how many operations use it. A slimmed document
 *  stores these already resolved, with the count in `x-ops`. */
function effectiveSecurity(doc: Json): { list: unknown[]; count: number }[] {
  const global = Array.isArray(doc.security) ? doc.security : undefined;
  const byKey = new Map<string, { list: unknown[]; count: number }>();
  const add = (list: unknown[], count: number) => {
    const norm = list.map((r) => (isObject(r) ? Object.keys(r).sort() : null)).filter((r) => r !== null);
    const key = JSON.stringify(norm);
    const prev = byKey.get(key);
    if (prev) prev.count += count;
    else byKey.set(key, { list, count });
  };
  const paths = isObject(doc.paths) ? doc.paths : {};
  let ops = 0;
  for (const item of Object.values(paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      ops++;
      const list = Array.isArray(op.security) ? op.security : global;
      if (list) add(list, typeof op["x-ops"] === "number" ? op["x-ops"] : 1);
    }
  }
  if (ops === 0 && global) add(global, 1);
  return [...byKey.values()];
}

/** Summarize a parsed OpenAPI 3.x or Swagger 2 document's authentication. */
export function summarizeSpecAuth(doc: unknown, specUrl?: string): SpecAuthSummary {
  if (!isObject(doc)) return { schemes: [], declared: [], referenced: false };
  const swagger2 = typeof doc.swagger === "string";
  const defs: Json = swagger2
    ? isObject(doc.securityDefinitions) ? doc.securityDefinitions : {}
    : isObject(doc.components) && isObject(doc.components.securitySchemes) ? doc.components.securitySchemes : {};

  const globalSecurity = Array.isArray(doc.security) ? doc.security : undefined;
  const lists = effectiveSecurity(doc).map(({ list, count }) => ({
    reqs: list.filter(isObject).map((r) => Object.keys(r)),
    count,
  }));

  const used = new Set(lists.flatMap((l) => l.reqs.flat()));
  const referenced = used.size > 0;
  const keys = referenced ? [...used] : Object.keys(defs);
  let schemes = keys.map((k) => (k in defs ? schemeSummary(k, defs[k], swagger2) : { key: k, type: "unsupported" as const, detail: "undefined scheme" }));

  // Google-style pairs: an implicit-only oauth2 scheme next to an
  // authorization-code scheme with the same authorize URL is one provider,
  // not a choice. (Apis.guru's Google specs even require both of such a pair
  // in one requirement object.)
  const codeUrls = new Set(
    schemes.flatMap((s) => (s.type === "oauth2" && s.tokenUrl && s.authorizationUrl ? [s.authorizationUrl] : [])),
  );
  const subsumed = new Set(
    schemes
      .filter((s) => s.type === "oauth2" && !s.tokenUrl && s.authorizationUrl && codeUrls.has(s.authorizationUrl))
      .map((s) => s.key),
  );

  // A scheme is a usable single credential when it alone satisfies (nearly)
  // every operation that requires auth. Requirements naming several schemes
  // at once (key + secret pairs) never count. A few odd operations (an upload
  // endpoint with its own JWT) do not disqualify an API-wide token.
  const declared = schemes.filter((s) => !subsumed.has(s.key));
  let combined = false;
  if (referenced) {
    const requiring = lists.filter((l) => l.reqs.length > 0 && !l.reqs.some((r) => r.length === 0));
    const total = requiring.reduce((n, l) => n + l.count, 0);
    const accepted = new Map<string, number>();
    for (const l of requiring) {
      const singles = new Set(
        l.reqs.map((r) => r.filter((k) => !subsumed.has(k))).filter((r) => r.length === 1).map((r) => r[0]!),
      );
      for (const k of singles) accepted.set(k, (accepted.get(k) ?? 0) + l.count);
    }
    const viable = new Set([...accepted].filter(([, n]) => total > 0 && n / total >= SINGLE_CREDENTIAL_COVERAGE).map(([k]) => k));
    combined = total > 0 && viable.size === 0;
    schemes = total > 0 ? schemes.filter((s) => viable.has(s.key)) : [];
  } else {
    schemes = schemes.filter((s) => !subsumed.has(s.key));
  }
  const opRequiresScheme = lists.some((l) => l.reqs.some((r) => r.length > 0));

  const { hosts, relative } = serverHosts(doc);
  const tenantHost = hosts.length > 0 && hosts.every((h) => PLACEHOLDER_HOST.test(h.replace(/:\d+$/, "")));
  let mirror = false;
  try {
    const specHost = specUrl ? new URL(specUrl).hostname : "";
    mirror = SPEC_MIRROR_HOSTS.some((m) => specHost === m || specHost.endsWith(`.${m}`));
  } catch {}
  const noServer = hosts.length === 0 && relative && mirror;

  const isPublic = globalSecurity !== undefined && globalSecurity.length === 0 && !opRequiresScheme;
  return {
    schemes,
    declared,
    referenced,
    ...(combined ? { combined } : {}),
    ...(isPublic ? { public: true } : {}),
    ...(tenantHost ? { tenantHost } : {}),
    ...(noServer ? { noServer } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** integrations.sh's own per-domain auth facts (`registry-auth.json`). */
export interface RegistryAuth {
  kind: Exclude<FeedAuthKind, "none">;
  header?: string;
  query?: string;
  oauth?: { authorizationUrl: string; tokenUrl: string };
  note?: string;
  /** Connection settings the service needs beyond the credential (a
   *  subdomain, a base URL). Such a service is never one-click. */
  requires?: string[];
}

export interface CuratedOpenapiAuth {
  auth?: string;
  authHeader?: string;
}

const headerName = (template: string | undefined): string | undefined =>
  template?.split(":")[0]?.trim().toLowerCase() || undefined;

/** The feed shape for one usable spec scheme, or undefined when it cannot be
 *  filled with one credential. */
export function schemeAuth(s: SchemeSummary): Omit<FeedAuth, "source"> | undefined {
  switch (s.type) {
    case "apiKey":
      if (s.in === "query") return { kind: "api_key", query: s.name, scheme: s.key };
      if (s.in === "header") {
        return s.bearerHint
          ? { kind: "token", header: `${s.name}: Bearer {token}`, scheme: s.key }
          : { kind: "api_key", header: `${s.name}: {api_key}`, scheme: s.key };
      }
      return undefined;
    case "bearer":
      return { kind: "token", header: "Authorization: Bearer {token}", scheme: s.key };
    case "basic":
      return { kind: "basic", header: "Authorization: Basic {username}:{password}", scheme: s.key };
    case "oauth2":
      return s.authorizationUrl && s.tokenUrl && /^https:\/\//.test(s.authorizationUrl) && /^https:\/\//.test(s.tokenUrl)
        ? {
            kind: "oauth",
            header: "Authorization: Bearer {access_token}",
            scheme: s.key,
            oauth: { authorizationUrl: s.authorizationUrl, tokenUrl: s.tokenUrl },
          }
        : undefined;
    default:
      return undefined;
  }
}

/** Whether a spec scheme carries the credential the way `template` says. */
function schemeMatches(s: SchemeSummary, want: { kind?: string; header?: string; query?: string }): boolean {
  const name = headerName(want.header);
  const bearer = /:\s*bearer\s/i.test(want.header ?? "");
  const basic = /:\s*basic\s/i.test(want.header ?? "");
  switch (s.type) {
    case "apiKey":
      if (s.in === "query") return !!want.query && want.query === s.name;
      return s.in === "header" && name === s.name.toLowerCase();
    case "bearer":
      return name === "authorization" && bearer && want.kind !== "oauth";
    case "basic":
      return name === "authorization" && basic;
    case "oauth2":
      return want.kind === "oauth";
    default:
      return false;
  }
}

/** Whether a scheme is the kind of credential a curated `auth` kind names. */
function kindAccepts(kind: FeedAuthKind, s: SchemeSummary): boolean {
  switch (kind) {
    case "oauth":
      return s.type === "oauth2";
    case "basic":
      return s.type === "basic";
    case "token":
      return s.type === "bearer" || (s.type === "apiKey" && s.in !== "cookie");
    case "api_key":
      return s.type === "apiKey" ? s.in !== "cookie" : s.type === "bearer";
    default:
      return false;
  }
}

export function isCompleteAuth(a: FeedAuth | undefined): boolean {
  if (!a) return false;
  if (a.kind === "none") return true;
  if (a.kind === "oauth") return !!a.oauth;
  return !!(a.header || a.query);
}

export interface ResolveInput {
  curated?: CuratedOpenapiAuth;
  spec?: SpecAuthSummary;
  registry?: RegistryAuth;
}

/** Combine the three sources into the feed's `auth`, or undefined. */
export function resolveOpenapiAuth({ curated, spec, registry }: ResolveInput): FeedAuth | undefined {
  // 1. Curated: a human checked it. Keep its values; borrow the spec's scheme
  //    key (and OAuth endpoints) when one carries the same credential.
  if (curated?.authHeader || curated?.auth) {
    const kind = (curated.auth ?? "api_key") as FeedAuthKind;
    if (kind === "none") return { kind, source: "curated" };
    const schemes = spec?.referenced ? spec.declared : [];
    // With a header, the spec scheme must carry that same header. Without
    // one, the curated kind picks among the spec's schemes.
    const matches = curated.authHeader
      ? schemes.filter((s) => schemeMatches(s, { kind, header: curated.authHeader }))
      : schemes.filter((s) => kindAccepts(kind, s));
    const usable = matches.map(schemeAuth).filter((a) => a !== undefined);
    const pick = usable.length === 1 ? usable[0] : undefined;
    const header = curated.authHeader ?? pick?.header;
    return {
      kind,
      ...(header ? { header } : {}),
      ...(!curated.authHeader && pick?.query ? { query: pick.query } : {}),
      ...(pick?.scheme ? { scheme: pick.scheme } : {}),
      ...(kind === "oauth" && pick?.oauth ? { oauth: pick.oauth } : {}),
      source: "curated",
    };
  }

  // Never one-click: the service needs a per-tenant host.
  if (registry?.requires?.length) return undefined;
  if (spec?.tenantHost || spec?.noServer) return undefined;

  // 2. The spec's own declaration.
  if (spec) {
    if (spec.public && spec.schemes.length === 0) return { kind: "none", source: "spec" };
    if (spec.combined) return undefined;
    if (spec.schemes.length === 1) {
      const s = spec.schemes[0]!;
      const only = schemeAuth(s);
      if (!only) return undefined;
      const { scheme, ...rest } = only;
      // An apiKey scheme names the header but not the value's format; a
      // registry template for that same header supplies the prefix
      // ("Authorization: {api_key}" vs "Authorization: Token {api_key}").
      if (
        s.type === "apiKey" && s.in === "header" && !s.bearerHint &&
        (registry?.kind === "api_key" || registry?.kind === "token") &&
        registry.header && !registry.requires?.length &&
        headerName(registry.header) === s.name.toLowerCase() &&
        /:\s*\S+\s+\{/.test(registry.header)
      ) {
        return {
          kind: registry.kind,
          header: registry.header,
          ...(spec.referenced ? { scheme } : {}),
          ...(registry.note ? { note: registry.note } : {}),
          source: "registry",
        };
      }
      return { ...rest, ...(spec.referenced ? { scheme } : {}), source: "spec" };
    }
    if (spec.schemes.length > 1) {
      // Several schemes: only registry data that picks exactly one decides.
      if (!registry) return undefined;
      const picked = spec.schemes.filter((s) => schemeMatches(s, registry) && schemeAuth(s) !== undefined);
      if (picked.length !== 1) return undefined;
      const one = schemeAuth(picked[0]!);
      if (!one) return undefined;
      const { scheme, ...rest } = one;
      return {
        ...rest,
        ...(spec.referenced ? { scheme } : {}),
        ...(registry.note ? { note: registry.note } : {}),
        source: "registry",
      };
    }
  }

  // 3. No declared security: registry data, without a scheme.
  if (registry) {
    const { kind, header, query, oauth, note } = registry;
    const out: FeedAuth = {
      kind,
      ...(header ? { header } : {}),
      ...(query ? { query } : {}),
      ...(oauth ? { oauth } : {}),
      ...(note ? { note } : {}),
      source: "registry",
    };
    return isCompleteAuth(out) ? out : undefined;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry data
// ─────────────────────────────────────────────────────────────────────────────

const KINDS = new Set(["api_key", "token", "basic", "oauth"]);
const TEMPLATE = /^[A-Za-z0-9-]+: (?:[A-Za-z][A-Za-z0-9-]* )?\{[a-z][a-z0-9_]*\}(?::\{[a-z][a-z0-9_]*\})?$/;

/** Parse and validate `registry-auth.json`; throws on any malformed entry so
 *  a bad edit fails the build instead of shipping. */
export function parseRegistryAuth(json: unknown): Map<string, RegistryAuth> {
  if (!isObject(json) || !isObject(json.entries)) throw new Error("registry-auth.json: expected { entries: {...} }");
  const out = new Map<string, RegistryAuth>();
  const errors: string[] = [];
  for (const [domain, raw] of Object.entries(json.entries)) {
    if (!isObject(raw)) {
      errors.push(`${domain}: not an object`);
      continue;
    }
    const e = raw as unknown as RegistryAuth;
    if (domain !== domain.toLowerCase() || !domain.includes(".")) errors.push(`${domain}: bad domain key`);
    if (!KINDS.has(e.kind)) errors.push(`${domain}: bad kind ${String(e.kind)}`);
    if (e.header !== undefined && !TEMPLATE.test(e.header)) errors.push(`${domain}: bad header template ${e.header}`);
    if (e.query !== undefined && !/^[A-Za-z0-9_.-]+$/.test(e.query)) errors.push(`${domain}: bad query name`);
    if (e.header && e.query) errors.push(`${domain}: header and query both set`);
    if (e.kind === "basic" && !/^Authorization: Basic \{[a-z_]+\}:\{[a-z_]+\}$/.test(e.header ?? "")) {
      errors.push(`${domain}: basic needs "Authorization: Basic {username}:{password}"`);
    }
    if (e.kind === "oauth" && !(e.oauth && /^https:\/\//.test(e.oauth.authorizationUrl) && /^https:\/\//.test(e.oauth.tokenUrl))) {
      errors.push(`${domain}: oauth needs https authorizationUrl and tokenUrl`);
    }
    if (e.kind !== "oauth" && !e.requires?.length && !e.header && !e.query) errors.push(`${domain}: no header or query`);
    out.set(domain, e);
  }
  if (errors.length) throw new Error(`registry-auth.json: invalid entries:\n${errors.join("\n")}`);
  return out;
}
