/**
 * Discovery agent — a bounded agentic loop that maps a domain's full public
 * integration surface and how to authenticate with it (the v3 data model;
 * see docs/discovery-model.md).
 *
 * The model drives its own trajectory: it searches and scrapes pages (via
 * context.dev — JS-rendered Markdown), following links until it can describe
 * every surface (API / GraphQL / MCP / CLI) and the credentials they accept.
 *
 * Output is built from FOUR discriminated unions:
 *   - Surface     (by `type`: http | graphql | mcp | cli)
 *   - Credential  (by `type`: Nango auth-mode vocabulary)
 *   - Mechanics   (by `source`: spec | well-known | metadata | http | cli | unknown)
 *   - Basis  (by `via`: detected | discovered | declared)
 *
 * Surfaces get a server-assigned `slug` at record time (slugified name,
 * deduped) — identity and URL segment. The model never produces it; the wire
 * layer (worker/operations.ts) preserves prior slugs across re-runs by
 * locator match.
 *
 * Credentials are a top-level registry, defined once; each surface's `auth`
 * entries reference a credential by id and carry only the per-surface binding.
 * Findings stream out: `record_credential` / `record_surface` the moment the
 * model confirms one, each emitted as a partial; `finish` ends the run.
 *
 * Seeded with detect()'s deterministic findings, which are merged back at the
 * end as basis:"detected". Model (`ChatFn`) and web tools (`WebBackend`)
 * are injected, so it runs identically in the Worker, Bun, and tests.
 */
import type { DetectionResult, McpDetection } from "./detect.ts";
import { probeMcpOnboarding } from "./detect.ts";
import { catalogSeeds } from "./catalog-seed.ts";
import { validateSpecUrl, type SpecValidationResult } from "./spec-validate.ts";

export const SLACK_MCP_USER_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "canvases:read",
  "canvases:write",
  "users:read",
  "users:read.email",
  "reactions:write",
  "reactions:read",
  "emoji:read",
  "files:read",
  "channels:write",
  "groups:write",
  "im:write",
  "mpim:write",
  "channels:read",
  "groups:read",
  "mpim:read",
] as const;

export const SLACK_MCP_MANIFEST = {
  display_information: { name: "Slack MCP client" },
  oauth_config: {
    scopes: { user: [...SLACK_MCP_USER_SCOPES] },
  },
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
    is_mcp_enabled: true,
  },
} as const;

export function slackMcpAppManifestUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MCP_MANIFEST))}`;
}

const MCP_MANUAL_ONBOARD_GENERIC_SETUP =
  "## OAuth 2.0 — pre-registered app required\n" +
  "This server does not support automatic client registration (no DCR or CIMD), so the MCP client cannot register itself. Create an OAuth app in the provider's developer settings, allow-list your MCP client's OAuth callback URL as a redirect URL, and give the client that app's client ID and secret. Then connect and approve access in the browser.";

const MCP_MANUAL_ONBOARD_HOSTS: Record<string, { setup: string; generateUrl?: string }> = {
  "mcp.slack.com": {
    generateUrl: slackMcpAppManifestUrl(),
    setup:
      "The Slack app must also have **Slack MCP server access** enabled (`settings.is_mcp_enabled: true` in the app manifest) — Slack rejects tokens from apps without it, and clients typically surface that as a generic connection failure.\n\n" +
      `Fastest path: [create a pre-configured Slack app](${slackMcpAppManifestUrl()}) — the manifest pre-fills the MCP flag and all \`search:read.*\`, history, and write scopes; you add your client's callback URL under **OAuth & Permissions** after creation, then copy the client ID and secret from **Basic Information**.`,
  },
  "slack.com": {
    generateUrl: slackMcpAppManifestUrl(),
    setup:
      "The Slack app must also have **Slack MCP server access** enabled (`settings.is_mcp_enabled: true` in the app manifest) — Slack rejects tokens from apps without it, and clients typically surface that as a generic connection failure.\n\n" +
      `Fastest path: [create a pre-configured Slack app](${slackMcpAppManifestUrl()}) — the manifest pre-fills the MCP flag and all \`search:read.*\`, history, and write scopes; you add your client's callback URL under **OAuth & Permissions** after creation, then copy the client ID and secret from **Basic Information**.`,
  },
};

// ── injected model (OpenAI-style tool-calling) ────────────────────────────────

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export type ChatFn = (
  messages: unknown[],
  tools: unknown[],
) => Promise<{ message: unknown; toolCalls: ParsedToolCall[] }>;

// ── injected web backend (context.dev, or a naive fallback) ───────────────────

export interface SearchHit {
  url: string;
  title: string;
  description: string;
  relevance: string;
}
export interface WebBackend {
  readonly canSearch: boolean;
  search(query: string): Promise<SearchHit[]>;
  scrape(url: string): Promise<string>;
  sitemap(domain: string, urlRegex?: string): Promise<string[]>;
}

// ── output: four discriminated unions (docs/discovery-model.md) ───────────────

/** How we learned a thing exists — a trust/verifiability axis. */
export type Basis =
  | { via: "detected"; signal: string; verifiedAt?: string } // re-verifiable machine signal
  | { via: "discovered"; evidence: string[] } // doc URLs the agent read
  | { via: "declared"; source: string }; // owner-published integrations.json

/** How ONE credential binds to a surface — where the binding resolves from. */
export type Mechanics =
  | { source: "spec"; scheme: string } // the OpenAPI securityScheme name this credential satisfies
  | { source: "well-known" } // derive from surface url via RFC 9728/8414
  | { source: "metadata"; url: string } // well-known at a non-standard location
  | { source: "http"; in?: "header" | "query" | "body" | "path"; headerName?: string; scheme?: string; paramName?: string }
  | { source: "cli"; command?: string; env?: string[] }
  | { source: "unknown" };

/** A credential: what it is + where you get it. Defined once, referenced by id. */
export interface Credential {
  /** Auth-mode vocabulary (Nango-derived): api_key | basic | bearer | oauth2 | oauth2_cc | jwt | app | two_step | signature | aws_sigv4 | compound | custom. */
  type: string;
  label: string;
  generateUrl?: string;
  setup: string; // markdown
  acquisition?: "manual" | "ambient";
  fields?: Record<string, { secret?: boolean; description?: string }>; // multi-secret credentials
}

/** One credential bound to a surface, with its own placement. */
export interface CredentialUse {
  id: string;
  mechanics: Mechanics;
}

/** One way to authenticate (OR alternative); `use[]` is AND'd, each placed independently. */
export interface AuthEntry {
  use: CredentialUse[];
  basis: Basis;
}

/** A surface's auth requirement — none | required | unknown. */
export type AuthStatus =
  | { status: "none"; basis: Basis }
  | { status: "required"; entries: AuthEntry[] }
  | { status: "unknown" };

/** One integration surface. Per-`type` fields are optional on the base. */
export interface Surface {
  /** Server-assigned at record time — identity + URL segment. Never model-authored. */
  slug: string;
  name: string;
  type: string; // http | graphql | mcp | cli
  docs?: string;
  basis: Basis;
  auth: AuthStatus;
  // http / graphql:
  spec?: string; // OpenAPI URL, or "introspection" / SDL URL for graphql
  specAlternates?: string[]; // same API, alternate machine-readable spec formats
  url?: string; // endpoint (required for graphql/mcp; http without spec)
  patch?: unknown; // securityScheme overrides
  // mcp:
  transports?: string[];
  // cli:
  packages?: Array<{ registryType: string; identifier: string; runtimeHint?: string }>;
  command?: string;
  // companion (server.json shapes):
  requiredHeaders?: Array<{ name: string; source: { kind: "static"; value: string } | { kind: "env"; envVar: string }; description?: string }>;
  variables?: Array<{ name: string; in?: "url" | "header" | "query"; resolveFrom?: string; description?: string }>;
  notes?: string;
}

export interface DiscoveryResult {
  summary: string;
  description?: string;
  credentials: Record<string, Credential>;
  surfaces: Surface[];
}

// ── streamed events (partials emitted as findings are confirmed) ──────────────

export type DiscoverEvent =
  | { kind: "progress"; message: string }
  | { kind: "credential"; id: string; credential: Credential }
  | { kind: "surface"; surface: Surface };
export type Emit = (event: DiscoverEvent) => void;

// ── tools ──────────────────────────────────────────────────────────────────────

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

const MECHANICS_PROPS = {
  source: { type: "string", description: "spec | well-known | metadata | http | cli | unknown" },
  scheme: { type: "string", description: "spec: the OpenAPI securityScheme name this credential satisfies. http: the HTTP scheme prefix, e.g. Bearer." },
  in: { type: "string", description: "http: header | query | body | path" },
  headerName: { type: "string" },
  paramName: { type: "string" },
  command: { type: "string", description: "cli: a command to run, e.g. 'wrangler login'" },
  env: { type: "array", items: { type: "string" }, description: "cli: env var(s) to set, e.g. ['CLOUDFLARE_API_TOKEN']" },
  url: { type: "string", description: "metadata: the non-standard well-known URL" },
};

const CRED_USE_PROPS = {
  id: { type: "string", description: "a credential id you recorded via record_credential" },
  mechanics: { type: "object", properties: MECHANICS_PROPS, required: ["source"], additionalProperties: false, description: "how THIS credential is bound on this surface" },
};

const AUTH_ENTRY_PROPS = {
  use: {
    type: "array",
    items: { type: "object", properties: CRED_USE_PROPS, required: ["id", "mechanics"], additionalProperties: false },
    description: "credentials sent TOGETHER for this one way in (AND) — each with its own placement. One element = a single credential.",
  },
  evidence: { type: "array", items: { type: "string" }, description: "doc URL(s) where you confirmed this auth applies" },
};

const SURFACE_PROPS = {
  name: { type: "string" },
  type: { type: "string", description: "http (REST/OpenAPI) | graphql | mcp | cli. `cli` is a genuine command-line EXECUTABLE the user runs in a shell — NOT a client SDK/library you import in code." },
  docs: { type: "string" },
  spec: { type: "string", description: "OpenAPI URL, or 'introspection'/SDL URL for graphql — a POINTER, never inline a spec" },
  specAlternates: { type: "array", items: { type: "string" }, description: "Additional machine-readable spec documents for the SAME API in other formats (e.g. the YAML twin of a JSON OpenAPI doc)." },
  url: { type: "string", description: "endpoint/home URL — required for graphql & mcp" },
  transports: { type: "array", items: { type: "string" }, description: "mcp: streamable-http | sse" },
  packages: { type: "array", items: { type: "object", properties: { registryType: { type: "string" }, identifier: { type: "string" }, runtimeHint: { type: "string" } }, required: ["registryType", "identifier"], additionalProperties: false }, description: "cli: install packages" },
  command: { type: "string", description: "cli: the command name" },
  requiredHeaders: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, envVar: { type: "string" }, description: { type: "string" } }, required: ["name"], additionalProperties: false }, description: "mandatory non-auth headers, e.g. version pins (anthropic-version)" },
  variables: { type: "array", items: { type: "object", properties: { name: { type: "string" }, in: { type: "string" }, resolveFrom: { type: "string" }, description: { type: "string" } }, required: ["name"], additionalProperties: false }, description: "instance/region IDs needed to build the URL (project_ref, cloudId)" },
  evidence: { type: "array", items: { type: "string" }, description: "doc URL(s) where you confirmed this surface" },
  authStatus: { type: "string", description: "required (default, give `auth`) | none (confirmed PUBLIC, no credential — give `publicEvidence`) | unknown (couldn't determine)" },
  auth: { type: "array", items: { type: "object", properties: AUTH_ENTRY_PROPS, required: ["use"], additionalProperties: false }, description: "for authStatus=required: the OR alternatives, each one way to authenticate to THIS surface" },
  publicEvidence: { type: "array", items: { type: "string" }, description: "for authStatus=none: doc URL(s) confirming the surface is public" },
};

const CREDENTIAL_PROPS = {
  id: { type: "string", description: "short stable id you reference from surface auth, e.g. 'cf_api_token'" },
  type: { type: "string", description: "api_key | basic | bearer | oauth2 | oauth2_cc | jwt | app | two_step | signature | aws_sigv4 | compound" },
  label: { type: "string" },
  generateUrl: { type: "string", description: "the page where the user mints/registers this credential" },
  setup: { type: "string", description: "markdown: where to go, what to click, gotchas — the human acquisition guide. Write EVERY URL as a markdown link [label](https://…), never a bare URL. Put literal values (header names, token prefixes, scopes, endpoint URLs the user pastes into config) in `backticks`." },
  acquisition: { type: "string", description: "manual (default) | ambient (env-injected, e.g. CI tokens)" },
};

const TOOLS = [
  fn("web_search", "Search the web to find a service's developer pages (docs, API reference, OAuth registration, CLI/SDK). Returns titles + URLs.", { query: { type: "string" } }, ["query"]),
  fn("scrape_sitemap", "FALLBACK ONLY — use when web_search doesn't surface the developer pages. Lists candidate URLs from the domain's sitemap; pass an optional RE2 regex to keep matching paths (e.g. 'api|docs|developer|graphql|sdk|cli|oauth').", { domain: { type: "string" }, urlRegex: { type: "string" } }, ["domain"]),
  fn("scrape_page", "Read a page as clean Markdown (JS-rendered, works on SPA docs). Follow links you find. Returns truncated text.", { url: { type: "string" } }, ["url"]),
  fn(
    "record_credential",
    "Define ONE credential the service issues (what it is + where you get it). Give it a short stable `id` you then reference from surface auth via `use`. Define each credential ONCE even if many surfaces accept it.",
    CREDENTIAL_PROPS,
    ["id", "type", "label", "setup"],
  ),
  fn(
    "record_surface",
    "Record ONE integration surface (API/GraphQL/MCP/CLI) and how to authenticate to it. Its `auth` entries are OR alternatives, each referencing credential id(s) you've recorded via record_credential, plus the per-surface binding `mechanics`. Pointers only; never inline a spec.",
    SURFACE_PROPS,
    ["name", "type"],
  ),
  fn(
    "finish",
    "Call when you've recorded every credential and surface. Provide both the integration-surface summary and the service registry description.",
    {
      summary: { type: "string", description: "One-line overview of the service's integration surface." },
      description: { type: "string", description: "1-2 sentences on what {domain}'s product/service actually does, for a registry listing. Plain, factual, no marketing superlatives." },
    },
    ["summary", "description"],
  ),
];

const SYSTEM =
  "You are the discovery agent for integrations.sh. Given a service domain, map its COMPLETE public integration " +
  "surface for developers and AI agents, and how to authenticate.\n\n" +
  "Find every surface: HTTP/REST APIs (type 'http' — attach the OpenAPI spec URL when one exists), GraphQL APIs, MCP servers, and CLIs — and every credential each accepts.\n\n" +
  "Data model — credentials are GLOBAL, bindings are PER-SURFACE:\n" +
  "- First record_credential for each distinct credential (API key, OAuth app, etc.) with a short id, what it is, and where to get it (markdown setup). Define each ONCE even if reused.\n" +
  "- Then record_surface for each surface. Set `authStatus`: 'required' (give `auth`), 'none' (the surface is PUBLIC/needs no credential — give `publicEvidence`), or 'unknown' (you couldn't determine it). Don't leave it required-with-empty.\n" +
  "- For authStatus=required, `auth` is the OR alternatives (any one works). Each entry's `use` is the credentials sent TOGETHER (AND), and EACH use carries its OWN `mechanics` — so an app-id in one header and an api-key in a differently-named header are two uses in one entry, each with its own placement.\n\n" +
  "Each use's mechanics.source tells where its binding resolves from: 'spec' (give the ONE OpenAPI securityScheme name this credential satisfies, in `scheme`), 'well-known' (MCP OAuth, derives from the url), 'http' (you read it from docs — give in/headerName/scheme), 'cli' (command/env), or 'unknown' (it exists but you couldn't pin the mechanics).\n\n" +
  "How to work — page by page:\n" +
  "- If seed facts include llms.txt contents, use them as the starting index for which docs pages to scrape; web_search can fill gaps, and scrape_page is still how you read the actual pages.\n" +
  "- Otherwise start with web_search to find the key developer pages. Then read the most relevant with scrape_page — issue SEVERAL scrape_page calls in the SAME turn so they run in parallel; don't read one, wait, read the next.\n" +
  "- After a batch of reads, record_credential / record_surface for what those pages revealed before reading more. Pass `evidence` (the doc URLs you read) on each surface and auth entry.\n" +
  "- Catalog facts are authoritative like detect signals: include a surface for each catalog fact, enrich it with docs/auth, and never contradict them.\n" +
  "- Capture spec/schema URLs as POINTERS; never inline a spec. Only state URLs/endpoints you actually saw. Never invent them.\n" +
  "- `spec` must be a MACHINE-READABLE document URL (ends .json/.yaml/.yml, or contains openapi/swagger; graphql: SDL URL or 'introspection'). A docs portal or API-reference page is NOT a spec — leave spec unset and put the page in `docs`.\n" +
  "- Map THE GIVEN DOMAIN only. If your searches keep landing on a DIFFERENT company's docs (a partner, a similarly-named product, a ?ref= link), do not map that company — conclude the given domain exposes nothing and finish with empty surfaces.\n" +
  "- ATTRIBUTE BY WHAT A SURFACE TALKS TO, not where its docs live. A surface belongs to the domain its requests actually hit — a CLI's or SDK's target API host, an HTTP API's base URL, an MCP server's connect URL. If docs on the given domain describe a CLI/API whose endpoint is a DIFFERENT registrable domain (e.g. docs on foo.dev but the CLI and API call foo.io), that surface belongs to foo.io — do NOT record it here. Record under the given domain only surfaces whose endpoint is the given domain or a subdomain of it. When unsure of a CLI's endpoint, check its docs for the host it authenticates against.\n" +
  "- A surface is something a developer INTEGRATES WITH. OAuth authorize/token/device endpoints, webhook delivery URLs, and status pages are NOT surfaces — OAuth mechanics belong in the credential's setup, webhooks in the API surface's notes. One API = one http surface, not one per endpoint.\n" +
  "- Swagger UI / ReDoc / API-explorer pages are RENDERINGS of an API's docs — never separate surfaces. Record the one API surface with the real spec URL, and use the explorer page as `docs` at most.\n" +
  "- Give every http surface its API BASE URL in `url` when the docs show one (e.g. https://api.example.com/v1) — most API reference pages state it. A docs-index/landing page is not a surface either; record the product APIs it links to.\n" +
  "- example.com/org hosts in docs are placeholders from spec `servers` blocks, never real endpoints — use the templated form or omit the url.\n" +
  "- Tenant-templated base URLs are valid locators — record them verbatim with placeholders ({account}.api.example.com, https://<your-instance>.example.com/api). An empty `url` because the host varies per tenant is wrong.\n" +
  "- Web dashboards/consoles and CI integrations (GitHub Actions, marketplace apps) are NOT surfaces — only programmatic interfaces a developer or agent calls: HTTP/GraphQL APIs, MCP connect endpoints, CLIs. When in doubt ask: could a script call this? If not, omit it.\n" +
  "- A client SDK or library — an npm/pip/gem/etc. package you IMPORT in code (e.g. '<Product> JavaScript/TypeScript SDK', a Python client, an Android/iOS SDK) — is NOT a `cli` surface, and by itself is NOT a surface at all. It is a wrapper over an HTTP/GraphQL API: record THAT underlying API surface instead (its base URL / spec), attributed to the host the SDK actually calls. Reserve `cli` for a genuine command-line EXECUTABLE the user runs in a shell — a real binary with a `command` like `wrangler`, `gh`, `stripe`, `supabase` (a runtime like `python`/`node`/`npx` is NOT a command). If a service ships only an SDK/library and exposes no documented HTTP/GraphQL/MCP surface or standalone CLI, conclude it has no integration surface and finish with empty surfaces — do NOT file the SDK under `cli`.\n" +
  "- An mcp surface's `url` is the CONNECT ENDPOINT an MCP client would use (e.g. https://mcp.example.com/mcp), never a docs page about the server. If only a docs page exists, put it in `docs` and leave `url` unset.\n" +
  "- Write each credential's `setup` around the EASIEST acquisition path. When a CLI login acquires it (`mint login`, `wrangler login`), setup says 'run `x login`' and the binding is mechanics 'cli' with that command — do NOT walk through raw OAuth authorize/token/register endpoints anywhere in setup.\n" +
  "- When a CLI has an interactive `login` command AND the same credential can also be supplied via env var or a `--token`/`--key` flag, the `login` command is the PRIMARY path: write `setup` around 'run `x login`' and mention the env/flag token only as a non-interactive/CI fallback. NEVER lead with 'create a token in dashboard settings' when an interactive login exists — record both bindings (login as an acquisition command, env/flag as consumption) on the one credential.\n" +
  "- MCP servers almost always authenticate via OAuth with Dynamic Client Registration (DCR) or CIMD — the MCP client REGISTERS ITSELF and the user only completes an OAuth consent in the browser. Treat an OAuth-protected MCP server as SELF-ONBOARDING by default: its credential `setup` says the client registers automatically and the user just approves access, binding mechanics 'well-known'. Do NOT tell the user to create a developer-portal application, configure a redirect_uri, or copy a client_id/client_secret — UNLESS the server's docs EXPLICITLY require pre-registering an app (no DCR). When the well-known authorization-server metadata is available and shows no `registration_endpoint` and no CIMD support, describe manual app registration in the provider's developer portal instead. Manual app creation is at most a trailing fallback note, never the primary setup.\n" +
  "- Exotic auth (AWS SigV4, GitHub-App JWT exchange) — name the credential `type` (signature/aws_sigv4/app/two_step) and write the flow in `setup`; you don't need to model its execution. Use mechanics.source 'http', 'cli', or 'unknown'.\n" +
  "- Credentials are for DEVELOPER surfaces. An end-user app login (a consumer account for booking/shopping/streaming) is not an integration credential — omit it and the flows that need it.\n" +
  "- Record only credentials THIS service issues. A third-party platform's token that the service consumes (a BigCommerce API token you paste into an integration) belongs to that platform's own entry — mention it in the surface notes at most.\n" +
  "- A credential is something the user MINTS FOR THEMSELVES (their API key, their OAuth app). NEVER record shared, default, or example logins — a self-hosted product's factory password (admin/admin) is a security footgun, not a credential; use authStatus 'unknown' instead. Admin consoles of self-hosted installs are not public integration surfaces; omit them.\n" +
  "- When done, call finish with `summary` (one-line integration-surface overview) and `description` (1-2 plain factual sentences describing what the service/product does, not its developer surface). Omit surface types that don't exist.";

const MAX_STEPS = 16;
const MAX_SCRAPES = 30; // runaway guard, not a doc cap
const PER_DOC_CHARS = 8000;
export const LLMS_TXT_SEED_CONTENT_CHAR_LIMIT = 40_000;

// ── the loop ───────────────────────────────────────────────────────────────────

export async function discover(
  domain: string,
  detect: DetectionResult,
  chat: ChatFn,
  web: WebBackend,
  emit?: Emit,
): Promise<DiscoveryResult | null> {
  const seed = seedFacts(domain, detect);
  const ownerDeclaration = ownerDeclarationPrompt(detect);
  const catalogSeed = catalogSeeds(domain);
  const messages: unknown[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `Service domain: ${domain}\n` +
        `Detected by automated probes: ${detect.found.length ? detect.found.join(", ") : "nothing"}.\n` +
        (seed.length ? `Seed facts (authoritative):\n- ${seed.join("\n- ")}\n` : "") +
        (ownerDeclaration ? `${ownerDeclaration}\n` : "") +
        (catalogSeed.length ? `Catalog facts (authoritative — from curated registries; verify and include these surfaces):\n- ${catalogSeed.join("\n- ")}\n` : "") +
        (web.canSearch ? `\nStart with web_search for "${domain}".` : `\nStart from https://${domain}/docs or https://developer.${domain}/.`),
    },
  ];

  const credentials: Record<string, Credential> = {};
  const surfaces: Surface[] = [];
  const surfaceKeys = new Set<string>();
  const specValidations = new Map<string, SpecValidationResult>();
  const visited: string[] = [];
  let scrapes = 0;
  const progress = (m: string) => emit?.({ kind: "progress", message: m });

  const runTool = async (call: ParsedToolCall): Promise<string> => {
    switch (call.name) {
      case "web_search": {
        const q = String(call.arguments.query ?? "");
        progress(`Searching: ${q.slice(0, 60)}`);
        const hits = await web.search(q).catch(() => []);
        return hits.length ? hits.map((h, i) => `${i + 1}. ${h.title} — ${h.url}\n   ${h.description}`).join("\n") : `No results for "${q}".`;
      }
      case "scrape_sitemap": {
        progress("Scanning the sitemap…");
        const urls = await web.sitemap(String(call.arguments.domain ?? domain), call.arguments.urlRegex ? String(call.arguments.urlRegex) : undefined).catch(() => []);
        return urls.length ? `Sitemap URLs (${urls.length}):\n${urls.slice(0, 120).join("\n")}` : "No sitemap URLs found.";
      }
      case "scrape_page": {
        const url = String(call.arguments.url ?? "");
        if (!url) return "Missing url.";
        if (scrapes >= MAX_SCRAPES) return "Scrape budget reached — record anything left and call finish.";
        scrapes++;
        visited.push(url);
        progress(`Reading ${hostPath(url)}`);
        return `Markdown of ${url}:\n${(await web.scrape(url).catch(() => "")).slice(0, PER_DOC_CHARS)}`;
      }
      case "record_credential": {
        const id = str(call.arguments.id);
        const c = normalizeCredential(call.arguments);
        if (!id || !c) return "Ignored: a credential needs id, type, label, and setup.";
        if (credentials[id]) return `Already recorded credential ${id}.`;
        credentials[id] = c;
        emit?.({ kind: "credential", id, credential: c });
        return `Recorded credential ${id} (${c.type}).`;
      }
      case "record_surface": {
        const s = normalizeSurface(call.arguments);
        if (!s) return "Ignored: a surface needs at least type and name.";
        if ((s.type === "http" || s.type === "graphql") && s.spec && isSpecUrl(s.spec)) {
          const cached = specValidations.get(s.spec);
          const result = cached ?? await validateSpecUrl(s.spec, s.type);
          if (!cached) specValidations.set(s.spec, result);
          if (result.ok === false) {
            return `spec rejected: ${result.reason}. Either find the real machine-readable spec URL (look for a link to openapi.json/swagger.json/.yaml on the docs page), or re-record this surface WITHOUT spec and put that page URL in docs instead.`;
          }
          progress(`Validated spec ${hostPath(s.spec)} (${result.kind})`);
        }
        // Dangling credential references break the surface's whole auth story.
        if (s.auth.status === "required") {
          const missing = s.auth.entries.flatMap((e) => e.use.map((u) => u.id)).filter((id) => !credentials[id]);
          if (missing.length) {
            return `auth references undefined credential id(s): ${missing.join(", ")}. Call record_credential for each first (or use authStatus "unknown" if the credential isn't a real user-minted one), then re-record this surface.`;
          }
        }
        const key = `${s.type}|${(s.spec || s.url || s.name).toLowerCase()}`;
        if (surfaceKeys.has(key)) return `Already recorded ${s.name}.`;
        surfaceKeys.add(key);
        s.slug = assignSlug(s.name, surfaces);
        surfaces.push(s);
        emit?.({ kind: "surface", surface: s });
        const n = s.auth.status === "required" ? s.auth.entries.length : 0;
        return `Recorded surface: ${s.type} — ${s.name} (auth: ${s.auth.status}${n ? `, ${n} ${n === 1 ? "way" : "ways"}` : ""}).`;
      }
      default:
        return `Unknown tool "${call.name}".`;
    }
  };

  const finalize = async (summary: string, description?: string): Promise<DiscoveryResult> => {
    // Deterministically probe MCP servers the model discovered at hosts detect's
    // domain-scoped probes never reached (e.g. mcp.api.gusto.com/anthropic), so
    // merge() gets a real DCR/CIMD signal instead of trusting the model's prose.
    const known = new Set((detect.mcp ?? []).map((m) => m.url));
    const extra = surfaces.filter((s) => s.type === "mcp" && s.url && !known.has(s.url));
    if (extra.length) {
      const probed = await Promise.all(
        extra.map(async (s): Promise<McpDetection> => ({ url: s.url!, source: "discovered", ...(await probeMcpOnboarding(s.url!)) })),
      );
      detect = { ...detect, mcp: [...(detect.mcp ?? []), ...probed] };
    }
    return merge({ summary, description, credentials, surfaces }, detect, emit);
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const turn = await chat(messages, TOOLS);
    messages.push(turn.message);

    if (turn.toolCalls.length === 0) {
      messages.push({ role: "user", content: "Keep going — record any remaining credentials/surfaces, then call finish." });
      continue;
    }

    // Run this turn's tool calls concurrently — scrapes/searches are I/O-bound,
    // and the model usually requests several reads at once. Append results in
    // call order so every tool_call gets its tool message. record_* emits stream
    // as each resolves.
    let finishSummary: string | undefined;
    let finishDescription: string | undefined;
    const results = await Promise.all(
      turn.toolCalls.map((call) => (call.name === "finish" ? Promise.resolve("Done.") : runTool(call))),
    );
    turn.toolCalls.forEach((call, i) => {
      if (call.name === "finish") {
        finishSummary = typeof call.arguments.summary === "string" ? call.arguments.summary.trim() : "";
        finishDescription = typeof call.arguments.description === "string" ? call.arguments.description.trim() : undefined;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: results[i] });
    });
    if (finishSummary !== undefined) return finalize(finishSummary, finishDescription);
  }

  // Hit the step cap without a finish. Ask once, no tools, for just a one-line
  // summary so we return a real sentence instead of a robotic fallback.
  progress("Wrapping up…");
  let capSummary = "";
  try {
    messages.push({ role: "user", content: "Stop searching. In one line, summarize this service's integration surface and how to authenticate, based on what you've recorded. Reply with the sentence only." });
    const turn = await chat(messages, []);
    const c = (turn.message as { content?: unknown })?.content;
    if (typeof c === "string") capSummary = c.trim();
  } catch {
    /* keep empty → merge supplies a default */
  }
  return finalize(capSummary);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function seedFacts(domain: string, detect: DetectionResult): string[] {
  const facts: string[] = [];
  const o = detect.auth?.oauth;
  if (o?.authorizationEndpoint) facts.push(`OAuth authorization endpoint: ${o.authorizationEndpoint}`);
  if (o?.tokenEndpoint) facts.push(`OAuth token endpoint: ${o.tokenEndpoint}`);
  if (o?.registrationEndpoint) facts.push(`OAuth dynamic client registration at ${o.registrationEndpoint}`);
  if (o?.scopes?.length) facts.push(`OAuth scopes: ${o.scopes.slice(0, 30).join(", ")}`);
  for (const m of detect.mcp ?? []) facts.push(`MCP server endpoint: ${m.url}${m.auth ? ` (auth: ${m.auth})` : ""}`);
  if (detect.apiSchema) facts.push(`OpenAPI spec published at ${detect.apiSchema.url}`);
  if (detect.apiCatalog?.docs?.length) facts.push(`Docs linked from api-catalog: ${detect.apiCatalog.docs.join(", ")}`);
  if (detect.llmsTxt) {
    const url = detect.llmsTxt.url || `https://${domain}/llms.txt`;
    facts.push(
      `The domain publishes an llms.txt at ${url} — a plain-text index of its documentation. Contents:\n` +
      `<<<llms.txt\n${truncateLlmsTxtContent(detect.llmsTxt.content, url)}\n>>>`,
    );
  }
  return facts;
}

function truncateLlmsTxtContent(content: string, url: string): string {
  if (content.length <= LLMS_TXT_SEED_CONTENT_CHAR_LIMIT) return content;
  const capped = content.slice(0, LLMS_TXT_SEED_CONTENT_CHAR_LIMIT);
  const boundary = capped.lastIndexOf("\n");
  const body = boundary >= 0 ? capped.slice(0, boundary) : capped;
  const marker = `[llms.txt truncated at ${LLMS_TXT_SEED_CONTENT_CHAR_LIMIT} chars — full file at ${url}]`;
  return `${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${marker}`;
}

function ownerDeclarationPrompt(detect: DetectionResult): string {
  const declared = detect.integrationsJson;
  if (!declared?.result) return "";
  const json = JSON.stringify(declared.result, null, 2).slice(0, 20000);
  return (
    `Owner declaration from ${declared.url}:\n` +
    "The site owner declares the following (respect it as their statement of intent; enrich with docs; where our verified knowledge conflicts, note the discrepancy in the surface notes rather than silently dropping either).\n" +
    `${json}\n`
  );
}

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/$/, "").slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** URL-safe slug from a display name. */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isSpecUrl(spec: string): boolean {
  return /^https?:\/\//i.test(spec);
}

/** Server-assigned surface slug: slugified name, deduped within the result
 * (-2, -3… on collision). Prior-run continuity is applied later by the wire
 * layer, which rewrites slugs to match the previous result by locator. */
export function assignSlug(name: string, existing: { slug: string }[]): string {
  const base = slugifyName(name) || "surface";
  let slug = base;
  for (let n = 2; existing.some((s) => s.slug === slug); n++) slug = `${base}-${n}`;
  return slug;
}
const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);

function normalizeBasis(evidence: unknown): Basis {
  return { via: "discovered", evidence: strArr(evidence) };
}

function normalizeMechanics(o: unknown): Mechanics {
  const m = (o ?? {}) as Record<string, unknown>;
  const source = str(m.source);
  switch (source) {
    case "spec":
      return { source: "spec", scheme: str(m.scheme) ?? "" };
    case "well-known":
      return { source: "well-known" };
    case "metadata":
      return { source: "metadata", url: str(m.url) ?? "" };
    // "inline" accepted as a legacy alias; keys decide which v3 variant it is.
    case "http":
    case "cli":
    case "inline": {
      const command = str(m.command);
      const env = strArr(m.env);
      if (source === "cli" || ((command || env.length) && source !== "http")) {
        return { source: "cli", command, env: env.length ? env : undefined };
      }
      const inVal = str(m.in);
      return {
        source: "http",
        in: inVal === "header" || inVal === "query" || inVal === "body" || inVal === "path" ? inVal : undefined,
        headerName: str(m.headerName),
        scheme: str(m.scheme),
        paramName: str(m.paramName),
      };
    }
    default:
      return { source: "unknown" };
  }
}

function normalizeCredentialUse(o: unknown): CredentialUse | null {
  const u = (o ?? {}) as Record<string, unknown>;
  const id = str(u.id);
  if (!id) return null;
  return { id, mechanics: normalizeMechanics(u.mechanics) };
}

function normalizeAuthEntry(o: unknown): AuthEntry | null {
  const e = (o ?? {}) as Record<string, unknown>;
  const use = (Array.isArray(e.use) ? e.use : []).map(normalizeCredentialUse).filter((x): x is CredentialUse => x !== null);
  if (!use.length) return null;
  return { use, basis: normalizeBasis(e.evidence) };
}

/** Build a surface's AuthStatus from the model's authStatus + auth[] + publicEvidence. */
function normalizeAuthStatus(o: Record<string, unknown>): AuthStatus {
  if (str(o.authStatus) === "none") return { status: "none", basis: normalizeBasis(o.publicEvidence) };
  const seen = new Set<string>();
  const entries = (Array.isArray(o.auth) ? o.auth : [])
    .map(normalizeAuthEntry)
    .filter((x): x is AuthEntry => x !== null)
    .filter((a) => {
      const k = a.use.map((u) => `${u.id}:${JSON.stringify(u.mechanics)}`).sort().join("+");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return entries.length ? { status: "required", entries } : { status: "unknown" };
}

function normalizeCredential(o: Record<string, unknown>): Credential | null {
  const type = str(o.type);
  const label = str(o.label);
  const setup = str(o.setup);
  if (!type || !label || !setup) return null;
  const acq = str(o.acquisition);
  return {
    type: type.toLowerCase(),
    label,
    generateUrl: str(o.generateUrl),
    setup,
    acquisition: acq === "ambient" ? "ambient" : acq === "manual" ? "manual" : undefined,
  };
}

/** openapi/rest (v2 vocabulary, still occasionally emitted) fold into http. */
const foldType = (t: string): string => (t === "openapi" || t === "rest" ? "http" : t);

function normalizeSurface(o: Record<string, unknown>): Surface | null {
  const type = str(o.type);
  const name = str(o.name);
  if (!type || !name) return null;
  const packages: NonNullable<Surface["packages"]> = [];
  for (const p of Array.isArray(o.packages) ? o.packages : []) {
    const pp = (p ?? {}) as Record<string, unknown>;
    const rt = str(pp.registryType);
    const id = str(pp.identifier);
    if (rt && id) packages.push({ registryType: rt, identifier: id, runtimeHint: str(pp.runtimeHint) });
  }
  return {
    slug: "", // assigned by the caller (recordSurface) — stable, deduped
    name,
    type: foldType(type.toLowerCase()),
    docs: str(o.docs),
    basis: normalizeBasis(o.evidence),
    auth: normalizeAuthStatus(o),
    spec: str(o.spec),
    specAlternates: strArr(o.specAlternates).length ? strArr(o.specAlternates) : undefined,
    url: str(o.url),
    transports: strArr(o.transports).length ? strArr(o.transports) : undefined,
    packages: packages.length ? packages : undefined,
    command: str(o.command),
    requiredHeaders: normalizeReqHeaders(o.requiredHeaders),
    variables: normalizeVariables(o.variables),
    notes: str(o.notes),
  };
}

function normalizeReqHeaders(v: unknown): Surface["requiredHeaders"] {
  if (!Array.isArray(v)) return undefined;
  const out: NonNullable<Surface["requiredHeaders"]> = [];
  for (const it of v) {
    const o = (it ?? {}) as Record<string, unknown>;
    const name = str(o.name);
    if (!name) continue;
    const value = str(o.value);
    const envVar = str(o.envVar);
    const source = value ? { kind: "static" as const, value } : envVar ? { kind: "env" as const, envVar } : undefined;
    if (!source) continue; // a header with no value is useless — drop it
    out.push({ name, source, description: str(o.description) });
  }
  return out.length ? out : undefined;
}

function normalizeVariables(v: unknown): Surface["variables"] {
  if (!Array.isArray(v)) return undefined;
  const out: NonNullable<Surface["variables"]> = [];
  for (const it of v) {
    const o = (it ?? {}) as Record<string, unknown>;
    const name = str(o.name);
    if (!name) continue;
    const inVal = str(o.in);
    out.push({
      name,
      in: inVal === "header" || inVal === "query" || inVal === "url" ? inVal : undefined,
      resolveFrom: str(o.resolveFrom),
      description: str(o.description),
    });
  }
  return out.length ? out : undefined;
}

function declaredBasis(source: string): Basis {
  return { via: "declared", source };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function markDeclaredSurface(surface: Surface, source: string): Surface {
  const basis = declaredBasis(source);
  surface.basis = basis;
  if (surface.auth.status === "none") {
    surface.auth.basis = basis;
  } else if (surface.auth.status === "required") {
    for (const entry of surface.auth.entries) entry.basis = basis;
  }
  return surface;
}

function surfaceLocator(s: Surface): string {
  const packageId = s.packages?.[0]?.identifier;
  return `${s.type}|${(s.spec || s.url || s.command || packageId || s.name).toLowerCase()}`;
}

function entryKey(entry: AuthEntry): string {
  return entry.use
    .map((use) => `${use.id}:${JSON.stringify(use.mechanics)}`)
    .sort()
    .join("+");
}

function isDetectedBasis(basis: Basis | undefined): boolean {
  return basis?.via === "detected";
}

function addNote(surface: Surface, note: string): void {
  if (!note || surface.notes?.includes(note)) return;
  surface.notes = surface.notes ? `${surface.notes}\n${note}` : note;
}

function mergeDeclaredAuth(existing: Surface, declared: Surface): void {
  if (declared.auth.status === "unknown") return;
  if (existing.auth.status === "unknown") {
    existing.auth = declared.auth;
    return;
  }
  if (existing.auth.status === "none" && declared.auth.status === "none") {
    if (!isDetectedBasis(existing.auth.basis)) existing.auth.basis = declared.auth.basis;
    return;
  }
  if (existing.auth.status === "required" && declared.auth.status === "required") {
    const seen = new Map(existing.auth.entries.map((entry) => [entryKey(entry), entry]));
    for (const entry of declared.auth.entries) {
      const key = entryKey(entry);
      const match = seen.get(key);
      if (!match) {
        existing.auth.entries.push(entry);
      } else if (!isDetectedBasis(match.basis)) {
        match.basis = entry.basis;
      }
    }
    return;
  }
  addNote(existing, `Owner integrations.json declares auth status "${declared.auth.status}"; verified discovery kept "${existing.auth.status}".`);
}

function mergeDeclaredSurface(existing: Surface, declared: Surface): void {
  if (!isDetectedBasis(existing.basis)) existing.basis = declared.basis;
  for (const key of ["docs", "spec", "url", "command"] as const) {
    const declaredValue = declared[key];
    if (!declaredValue) continue;
    if (!existing[key]) {
      (existing as unknown as Record<string, unknown>)[key] = declaredValue;
    } else if (existing[key] !== declaredValue) {
      addNote(existing, `Owner integrations.json also declares ${key}: ${declaredValue}.`);
    }
  }
  if (!existing.transports && declared.transports) existing.transports = declared.transports;
  if (!existing.packages && declared.packages) existing.packages = declared.packages;
  if (!existing.requiredHeaders && declared.requiredHeaders) existing.requiredHeaders = declared.requiredHeaders;
  if (!existing.variables && declared.variables) existing.variables = declared.variables;
  if (declared.notes) addNote(existing, declared.notes);
  mergeDeclaredAuth(existing, declared);
}

function mergeDeclared(r: DiscoveryResult, detect: DetectionResult, emit?: Emit): void {
  const declared = detect.integrationsJson;
  if (!declared?.result) return;
  const source = declared.url;
  for (const [id, credential] of Object.entries(declared.result.credentials ?? {})) {
    if (!r.credentials[id]) {
      r.credentials[id] = cloneJson(credential) as Credential;
      emit?.({ kind: "credential", id, credential: r.credentials[id] });
    }
  }
  const byLocator = new Map(r.surfaces.map((surface) => [surfaceLocator(surface), surface]));
  for (const rawSurface of declared.result.surfaces ?? []) {
    const surface = markDeclaredSurface(cloneJson(rawSurface) as Surface, source);
    if (!surface.slug) surface.slug = assignSlug(surface.name || "Declared surface", r.surfaces);
    const existing = byLocator.get(surfaceLocator(surface));
    if (existing) {
      mergeDeclaredSurface(existing, surface);
      emit?.({ kind: "surface", surface: existing });
      continue;
    }
    surface.slug = assignSlug(surface.slug || surface.name || "Declared surface", r.surfaces);
    r.surfaces.push(surface);
    byLocator.set(surfaceLocator(surface), surface);
    emit?.({ kind: "surface", surface });
  }
}

/** Overlay detect's deterministic signals as basis:"detected". A detected
 * OAuth credential, plus the MCP and OpenAPI surfaces detect found, are
 * authoritative; anything newly added is emitted so the client stays in sync. */
function merge(r: DiscoveryResult, detect: DetectionResult, emit?: Emit): DiscoveryResult {
  // Detect probes ran as part of THIS discovery, so their signals verify now.
  const verifiedAt = new Date().toISOString();
  const oauth = detect.auth?.oauth;
  const hasDetOauth = oauth && (oauth.authorizationEndpoint || oauth.tokenEndpoint || oauth.registrationEndpoint || oauth.scopes?.length);

  // Ensure a detected OAuth credential exists (referenced by detected MCP auth).
  const ensureOauthCred = (): string => {
    const existing = Object.entries(r.credentials).find(([, c]) => /oauth/i.test(c.type) || /oauth/i.test(c.label));
    if (existing) return existing[0];
    const id = "oauth";
    const c: Credential = {
      type: "oauth2",
      label: "OAuth 2.0",
      setup:
        "## OAuth 2.0\n" +
        (oauth?.registrationEndpoint ? "Supports dynamic client registration — most clients register automatically. " : "") +
        "Authorize/token endpoints are published in the service's well-known metadata.",
    };
    r.credentials[id] = c;
    emit?.({ kind: "credential", id, credential: c });
    return id;
  };

  const has = (pred: (s: Surface) => boolean) => r.surfaces.some(pred);

  // A DCR/CIMD-capable MCP server is self-onboarding: the client registers
  // itself and the user only approves an OAuth consent. Rewrite the bound
  // credential to say exactly that — overriding any manual "create an app in the
  // developer portal, copy client_id/client_secret" story the model wrote from
  // docs — and bind the surface to it as a detected signal.
  const bindMcpSelfOnboard = (surface: Surface, mcp: McpDetection): void => {
    const id = ensureOauthCred();
    const c = r.credentials[id];
    c.type = "oauth2";
    c.label = "OAuth 2.0";
    c.generateUrl = undefined;
    c.acquisition = undefined;
    c.setup =
      "## OAuth 2.0 — self-onboarding\n" +
      "Point your MCP client at the server URL and approve access in the browser. " +
      (mcp.cimd
        ? "The server accepts a Client ID Metadata Document (CIMD), so the client authenticates with its own hosted URL as the `client_id` — nothing to register."
        : "The server supports OAuth Dynamic Client Registration (RFC 7591), so the client registers itself automatically — no developer-portal app, `client_id`, or `client_secret` to create.");
    emit?.({ kind: "credential", id, credential: c });
    surface.auth = {
      status: "required",
      entries: [{ use: [{ id, mechanics: { source: "well-known" } }], basis: { via: "detected", signal: mcp.cimd ? "client-id-metadata-document" : "oauth-dynamic-client-registration", verifiedAt } }],
    };
  };

  const mcpHostKnowledge = (url: string): { setup: string; generateUrl?: string } | undefined => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return MCP_MANUAL_ONBOARD_HOSTS[host] ?? MCP_MANUAL_ONBOARD_HOSTS[host.split(".").slice(-2).join(".")];
    } catch {
      return undefined;
    }
  };

  const isMcpManualOnboard = (mcp: McpDetection): boolean => mcp.authorizationServerMetadataFetched === true && !mcp.dcr && !mcp.cimd;

  const bindMcpManualOnboard = (surface: Surface, mcp: McpDetection): void => {
    const id = ensureOauthCred();
    const c = r.credentials[id];
    const hostKnowledge = mcpHostKnowledge(mcp.url);
    c.type = "oauth2";
    c.label = "OAuth 2.0";
    c.generateUrl = hostKnowledge?.generateUrl;
    c.acquisition = undefined;
    c.setup = `${MCP_MANUAL_ONBOARD_GENERIC_SETUP}${hostKnowledge ? `\n\n${hostKnowledge.setup}` : ""}`;
    emit?.({ kind: "credential", id, credential: c });
    surface.auth = {
      status: "required",
      entries: [{ use: [{ id, mechanics: { source: "well-known" } }], basis: { via: "detected", signal: "oauth-no-dynamic-registration", verifiedAt } }],
    };
  };

  // Detected MCP servers — authoritative.
  for (const mcp of detect.mcp ?? []) {
    const existing = r.surfaces.find((s) => s.type === "mcp" && s.url === mcp.url);
    if (existing) {
      existing.basis = { via: "detected", signal: "mcp:initialize", verifiedAt };
      if (mcp.dcr || mcp.cimd) bindMcpSelfOnboard(existing, mcp);
      else if (isMcpManualOnboard(mcp)) bindMcpManualOnboard(existing, mcp);
      emit?.({ kind: "surface", surface: existing });
      continue;
    }
    const auth: AuthStatus =
      hasDetOauth || mcp.auth
        ? { status: "required", entries: [{ use: [{ id: ensureOauthCred(), mechanics: { source: "well-known" } }], basis: { via: "detected", signal: "oauth-protected-resource", verifiedAt } }] }
        : { status: "unknown" };
    const s: Surface = { slug: assignSlug("MCP server", r.surfaces), name: "MCP server", type: "mcp", url: mcp.url, basis: { via: "detected", signal: "mcp:initialize", verifiedAt }, auth, notes: mcp.dcr || mcp.cimd ? "Self-onboarding (DCR/CIMD)" : undefined };
    r.surfaces.unshift(s);
    if (mcp.dcr || mcp.cimd) bindMcpSelfOnboard(s, mcp);
    else if (isMcpManualOnboard(mcp)) bindMcpManualOnboard(s, mcp);
    emit?.({ kind: "surface", surface: s });
  }

  // Detected OpenAPI spec — authoritative. Auth is `unknown` (detect doesn't parse schemes).
  if (detect.apiSchema) {
    const existing = r.surfaces.find((s) => s.type === "http" && (s.spec === detect.apiSchema!.url || s.url === detect.apiSchema!.url));
    if (existing) {
      existing.basis = { via: "detected", signal: "openapi:schema", verifiedAt };
      if (!existing.spec) existing.spec = detect.apiSchema.url;
      emit?.({ kind: "surface", surface: existing });
    } else if (!has((s) => s.type === "http")) {
      const s: Surface = { slug: assignSlug("OpenAPI", r.surfaces), name: "OpenAPI", type: "http", spec: detect.apiSchema.url, basis: { via: "detected", signal: "openapi:schema", verifiedAt }, auth: { status: "unknown" } };
      r.surfaces.push(s);
      emit?.({ kind: "surface", surface: s });
    }
  }

  mergeDeclared(r, detect, emit);

  if (!r.summary && r.surfaces.length) {
    r.summary = `Exposes ${[...new Set(r.surfaces.map((s) => s.type))].join(", ")} for this service.`;
  }
  return r;
}
