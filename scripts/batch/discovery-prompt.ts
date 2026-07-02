/**
 * The one-shot batch discovery prompt.
 *
 * The overnight batch path replaces the agentic loop in src/lib/discover.ts:
 * pages are scraped deterministically beforehand, then ONE big-context call
 * (gpt-5.4, 1M ctx, via the OpenAI Batch API) per domain emits the COMPLETE
 * DiscoveryResult as structured JSON — no tools, no trajectory.
 *
 * This module exports the three pieces that call needs:
 *   - SYSTEM               — the system prompt (rules + few-shots)
 *   - buildUserMessage()   — assembles the user turn from (domain, corpus)
 *   - DISCOVERY_JSON_SCHEMA — the json_schema for OpenAI structured outputs
 *
 * The JSON Schema mirrors src/lib/discovery-schema.ts (the Effect wire
 * contract) but in OpenAI's structured-output dialect:
 *   - discriminated unions are `anyOf` over branch objects, each pinned by a
 *     `const` tag field (Effect uses the same tags: Basis.via, Mechanics.source,
 *     AuthStatus.status, Surface.type, credential type is a plain enum);
 *   - EVERY property is listed in its object's `required` and every optional
 *     field is made nullable (`["T","null"]` / a "null" branch), per OpenAI's
 *     rule that structured outputs require all keys present;
 *   - `additionalProperties:false` everywhere.
 *
 * The model never authors surface slugs, the top-level `version`, or
 * `discoveredAt` — the caller assigns those (see src/lib/discover.ts
 * assignSlug / the merge step). So this schema omits them; the caller stitches
 * them on before decoding against the full DiscoveryResult.
 */

// ── the credential auth-mode vocabulary (mirrors CredentialType) ──────────────
const CREDENTIAL_TYPES = [
  "api_key",
  "basic",
  "bearer",
  "oauth2",
  "oauth2_cc",
  "oauth1",
  "jwt",
  "app",
  "two_step",
  "signature",
  "aws_sigv4",
  "tba",
  "compound",
  "custom",
] as const;

// ── shared schema fragments ───────────────────────────────────────────────────

/** OpenAI structured outputs require every key in `required`; optionals are
 * expressed as a nullable type. Small helper to keep the schema readable. */
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const nullableStr = { type: ["string", "null"] };
const strArray = { type: "array", items: { type: "string" } };
const SPEC_ALTERNATES_DESCRIPTION = "Additional machine-readable spec documents for the SAME API in other formats (e.g. the YAML twin of a JSON OpenAPI doc).";

// Basis — how we learned a thing exists (discriminated on `via`).
const BASIS_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        via: { type: "string", const: "detected" },
        signal: { type: "string", description: "A re-verifiable machine signal the service publishes (e.g. 'openapi:securitySchemes', 'oauth-protected-resource'). Rare from a scrape — prefer 'discovered'." },
        verifiedAt: nullableStr,
      },
      required: ["via", "signal", "verifiedAt"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        via: { type: "string", const: "discovered" },
        evidence: { ...strArray, description: "Doc URL(s) from the corpus that confirm this. Every URL MUST appear in the corpus." },
      },
      required: ["via", "evidence"],
    },
  ],
  description: "How we learned a thing exists. From a scrape you almost always emit `discovered` with the corpus URLs you read.",
};

// Mechanics — how ONE credential binds to a surface (discriminated on `source`).
const MECHANICS_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string", const: "spec" }, scheme: { type: "string", description: "The OpenAPI securityScheme NAME this one credential satisfies." } },
      required: ["source", "scheme"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string", const: "well-known" } },
      required: ["source"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string", const: "metadata" }, url: { type: "string", description: "The non-standard well-known metadata location." } },
      required: ["source", "url"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", const: "http" },
        in: { anyOf: [{ enum: ["header", "query", "body", "path"] }, { type: "null" }], description: "Where the credential rides. Default header." },
        headerName: nullableStr,
        scheme: { ...nullableStr, description: "HTTP auth scheme prefix, e.g. 'Bearer'." },
        paramName: nullableStr,
      },
      required: ["source", "in", "headerName", "scheme", "paramName"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", const: "cli" },
        command: { ...nullableStr, description: "A command that ACQUIRES/binds the credential, e.g. 'mint login', 'wrangler login'." },
        env: { anyOf: [strArray, { type: "null" }], description: "Env var(s) that carry the credential, e.g. ['RESEND_API_KEY']." },
      },
      required: ["source", "command", "env"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string", const: "unknown" } },
      required: ["source"],
    },
  ],
  description: "How a credential binds to a surface. Use 'cli' when a login command acquires it; 'http' when it rides the request; 'spec' when an OpenAPI scheme names it.",
};

// A credential the service issues (plain struct; `type` is an enum).
const CREDENTIAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Short stable id you reference from surface auth via use[].id, e.g. 'resend_api_key'." },
    type: { enum: CREDENTIAL_TYPES as unknown as string[], description: "The credential strategy." },
    label: { type: "string", description: "Human label, e.g. 'Resend API key'." },
    generateUrl: { ...nullableStr, description: "The page (from the corpus) where the user MINTS the credential. Null for CLI-login creds acquired by a command." },
    setup: {
      type: "string",
      description:
        "Markdown: a human acquisition guide written around the EASIEST path. Where to go, what to click, gotchas. " +
        "If a CLI login acquires it, the guide is 'run `x login`' — NOT an OAuth authorize/token endpoint walkthrough. " +
        "Write EVERY URL as a markdown link [label](https://…); put literal values (header names, token prefixes, scopes, commands) in `backticks`.",
    },
    acquisition: { anyOf: [{ enum: ["manual", "ambient"] }, { type: "null" }], description: "manual (default) | ambient (env-injected, e.g. CI tokens)." },
    fields: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { name: { type: "string" }, secret: { type: ["boolean", "null"] }, description: nullableStr },
            required: ["name", "secret", "description"],
          },
        },
        { type: "null" },
      ],
      description: "Named sub-secrets for an inherently multi-part credential (compound / GitHub-App appId+privateKey / basic email+token). Null for a single-secret credential. (An array here; the caller keys it into a record.)",
    },
  },
  required: ["id", "type", "label", "generateUrl", "setup", "acquisition", "fields"],
};

// One credential bound to a surface.
const CREDENTIAL_USE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "References a credential id from `credentials`." },
    mechanics: MECHANICS_SCHEMA,
  },
  required: ["id", "mechanics"],
};

// One way to authenticate (OR alternative); use[] is AND'd.
const AUTH_ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    use: { type: "array", items: CREDENTIAL_USE_SCHEMA, description: "Credentials sent TOGETHER (AND), each with its own placement. One element = a single credential." },
    basis: BASIS_SCHEMA,
  },
  required: ["use", "basis"],
};

// AuthStatus — none | required | unknown (discriminated on `status`).
const AUTH_STATUS_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string", const: "none" }, basis: BASIS_SCHEMA },
      required: ["status", "basis"],
      description: "Confirmed PUBLIC — no credential needed. `basis.evidence` MUST cite corpus URL(s) that say so.",
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string", const: "required" }, entries: { type: "array", items: AUTH_ENTRY_SCHEMA, description: "OR alternatives — at least one is needed." } },
      required: ["status", "entries"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string", const: "unknown" } },
      required: ["status"],
      description: "Auth not determinable from the corpus (NOT the same as public).",
    },
  ],
  description: "A surface's auth requirement. `none` requires publicEvidence; never leave a required surface with empty entries — use `unknown` instead.",
};

// Companion, non-auth surface fields.
const REQUIRED_HEADER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    source: {
      anyOf: [
        { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "static" }, value: { type: "string" } }, required: ["kind", "value"] },
        { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "env" }, envVar: { type: "string" } }, required: ["kind", "envVar"] },
      ],
    },
    description: nullableStr,
  },
  required: ["name", "source", "description"],
};

const VARIABLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "A token substituted wherever {name} appears in the surface url." },
    in: { anyOf: [{ enum: ["url", "header", "query"] }, { type: "null" }], description: "Default 'url'." },
    resolveFrom: nullableStr,
    description: nullableStr,
  },
  required: ["name", "in", "resolveFrom", "description"],
};

// Per-surface-kind fields, all optional (nullable) on the widened branch.
const surfaceBaseProps = {
  name: { type: "string", description: "Display name (NOT identity — the caller assigns the slug)." },
  docs: { ...nullableStr, description: "Human docs URL (from the corpus)." },
  basis: BASIS_SCHEMA,
  auth: AUTH_STATUS_SCHEMA,
  requiredHeaders: { anyOf: [{ type: "array", items: REQUIRED_HEADER_SCHEMA }, { type: "null" }], description: "Mandatory NON-auth headers (a version pin, a required User-Agent)." },
  variables: { anyOf: [{ type: "array", items: VARIABLE_SCHEMA }, { type: "null" }] },
  notes: nullableStr,
};
const surfaceBaseRequired = ["name", "docs", "basis", "auth", "requiredHeaders", "variables", "notes"];

// Surface — discriminated on `type`.
const SURFACE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "http" },
        spec: { ...nullableStr, description: "MACHINE-READABLE OpenAPI doc URL (a pointer, never inlined). Must end in .json/.yaml/.yml or contain openapi/swagger. A docs portal is NOT a spec — leave null." },
        specAlternates: { anyOf: [strArray, { type: "null" }], description: SPEC_ALTERNATES_DESCRIPTION },
        url: { ...nullableStr, description: "Base URL — when there's no spec, or not derivable from the spec." },
        ...surfaceBaseProps,
      },
      required: ["type", "spec", "specAlternates", "url", ...surfaceBaseRequired],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "graphql" },
        url: { ...nullableStr, description: "The GraphQL endpoint (a schema has no endpoint of its own)." },
        spec: { ...nullableStr, description: "'introspection' or an SDL URL." },
        specAlternates: { anyOf: [strArray, { type: "null" }], description: SPEC_ALTERNATES_DESCRIPTION },
        ...surfaceBaseProps,
      },
      required: ["type", "url", "spec", "specAlternates", ...surfaceBaseRequired],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "mcp" },
        url: { ...nullableStr, description: "The MCP connect endpoint (NOT a docs page)." },
        transports: { anyOf: [strArray, { type: "null" }], description: "streamable-http | sse." },
        ...surfaceBaseProps,
      },
      required: ["type", "url", "transports", ...surfaceBaseRequired],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "cli" },
        command: { ...nullableStr, description: "The command name, e.g. 'mint'." },
        packages: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { registryType: { type: "string", description: "npm | pypi | oci | brew | …" }, identifier: { type: "string" }, runtimeHint: nullableStr },
                required: ["registryType", "identifier", "runtimeHint"],
              },
            },
            { type: "null" },
          ],
          description: "Install options.",
        },
        ...surfaceBaseProps,
      },
      required: ["type", "command", "packages", ...surfaceBaseRequired],
    },
  ],
  description: "One integration surface. Emit ONLY the types that actually exist — no empty placeholder surfaces.",
};

/** The full structured-output schema for one domain's discovery. Wrap this as
 * `{ type: "json_schema", json_schema: { name: "discovery", strict: true, schema: DISCOVERY_JSON_SCHEMA } }`
 * in the response_format. `credentials` is emitted as an ARRAY (each item
 * carries its own `id`); the caller folds it into the Record the wire schema
 * wants. `version`/`discoveredAt`/surface `slug` are assigned caller-side. */
const DISCOVERY_SCHEMA_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    domain: { type: "string" },
    summary: { type: "string", description: "One-line overview of the service's integration surface." },
    credentials: {
      type: "array",
      items: CREDENTIAL_SCHEMA,
      description: "Global credential registry (each item carries its own `id`). Define each credential ONCE even if many surfaces accept it. May be empty.",
    },
    surfaces: { type: "array", items: SURFACE_SCHEMA, description: "Typed surface inventory. Empty when the service has no public integration surface." },
  },
  required: ["domain", "summary", "credentials", "surfaces"],
} as const;

/** OpenAI response_format envelope: json_schema needs {name, strict, schema}. */
export const DISCOVERY_JSON_SCHEMA = {
  name: "discovery_result",
  strict: true,
  schema: DISCOVERY_SCHEMA_BODY,
} as const;

// ── the system prompt ─────────────────────────────────────────────────────────

/** Ideal minimal outputs, embedded as few-shots. Kept in the SAME shape the
 * schema requires (credentials as an array, all keys present) so the model
 * mirrors them exactly. */
const FEWSHOT_RESEND = {
  domain: "resend.com",
  summary: "Resend exposes a REST email API authenticated with a Bearer API key you mint in the dashboard.",
  credentials: [
    {
      id: "resend_api_key",
      type: "api_key",
      label: "Resend API key",
      generateUrl: "https://resend.com/api-keys",
      setup:
        "Create a key in the [API Keys dashboard](https://resend.com/api-keys): click **Create API Key**, name it, and pick a permission (full access or sending-only). " +
        "Copy the value — it starts with `re_` and is shown **once**. Send it as `Authorization: Bearer re_…`.",
      acquisition: "manual",
      fields: null,
    },
  ],
  surfaces: [
    {
      type: "http",
      spec: "https://resend.com/openapi.json",
      specAlternates: ["https://resend.com/openapi.yaml"],
      url: "https://api.resend.com",
      name: "Resend API",
      docs: "https://resend.com/docs/api-reference/introduction",
      basis: { via: "discovered", evidence: ["https://resend.com/docs/api-reference/introduction", "https://resend.com/openapi.json", "https://resend.com/openapi.yaml"] },
      auth: {
        status: "required",
        entries: [
          {
            use: [{ id: "resend_api_key", mechanics: { source: "http", in: "header", headerName: "Authorization", scheme: "Bearer", paramName: null } }],
            basis: { via: "discovered", evidence: ["https://resend.com/docs/api-reference/introduction"] },
          },
        ],
      },
      requiredHeaders: [
        { name: "User-Agent", source: { kind: "static", value: "your-app/1.0" }, description: "Mandatory on every request; a missing User-Agent returns 403." },
      ],
      variables: null,
      notes: null,
    },
  ],
};

const FEWSHOT_MINTLIFY = {
  domain: "mintlify.com",
  summary: "Mintlify offers a REST admin API (Bearer key) and a `mint` CLI whose login handles auth for you.",
  credentials: [
    {
      id: "mint_admin_key",
      type: "api_key",
      label: "Mintlify admin API key",
      generateUrl: "https://app.mintlify.com/settings/organization/api-keys",
      setup:
        "In the dashboard, open [Settings → Organization → API Keys](https://app.mintlify.com/settings/organization/api-keys) and create an admin key. " +
        "It begins with `mint_` and is a server-side secret — keep it off the client. Send it as `Authorization: Bearer mint_…`.",
      acquisition: "manual",
      fields: null,
    },
    {
      id: "mint_cli_session",
      type: "oauth2",
      label: "Mintlify CLI session",
      generateUrl: null,
      setup:
        "Run [`mint login`](https://www.mintlify.com/docs/cli/commands) — it opens your browser to authenticate and stores the session under `~/.config/mintlify/config.json`. " +
        "No key to copy: the command does the whole flow. Run `mint logout` to sign out.",
      acquisition: "manual",
      fields: null,
    },
  ],
  surfaces: [
    {
      type: "http",
      spec: null,
      specAlternates: null,
      url: "https://api.mintlify.com/v1",
      name: "Mintlify API",
      docs: "https://mintlify.com/docs/api-reference/introduction",
      basis: { via: "discovered", evidence: ["https://mintlify.com/docs/api-reference/introduction"] },
      auth: {
        status: "required",
        entries: [
          {
            use: [{ id: "mint_admin_key", mechanics: { source: "http", in: "header", headerName: "Authorization", scheme: "Bearer", paramName: null } }],
            basis: { via: "discovered", evidence: ["https://mintlify.com/docs/api-reference/introduction"] },
          },
        ],
      },
      requiredHeaders: null,
      variables: null,
      notes: null,
    },
    {
      type: "cli",
      command: "mint",
      packages: [{ registryType: "npm", identifier: "mint", runtimeHint: null }],
      name: "Mintlify CLI",
      docs: "https://www.mintlify.com/docs/cli/commands",
      basis: { via: "discovered", evidence: ["https://www.mintlify.com/docs/installation", "https://www.mintlify.com/docs/cli/commands"] },
      auth: {
        status: "required",
        entries: [
          {
            use: [{ id: "mint_cli_session", mechanics: { source: "cli", command: "mint login", env: null } }],
            basis: { via: "discovered", evidence: ["https://www.mintlify.com/docs/cli/commands"] },
          },
        ],
      },
      requiredHeaders: null,
      variables: null,
      notes: null,
    },
  ],
};

const FEWSHOT_NOAPI = {
  domain: "example-agency.com",
  summary: "A design agency with no public API, SDK, MCP server, or CLI — nothing to integrate against.",
  credentials: [],
  surfaces: [],
};

const fewshot = (title: string, obj: unknown) => `Example — ${title}:\n${JSON.stringify(obj, null, 2)}`;

export const SYSTEM = [
  "You are the batch discovery engine for integrations.sh. You are given a service domain and a CORPUS: an array of pages",
  "(url, optional title, content) that were scraped from the service's site beforehand. From the corpus ALONE, emit ONE JSON",
  "object describing the service's COMPLETE public integration surface for developers and AI agents, and how to authenticate.",
  "",
  "Output the JSON only — it must conform to the provided schema. Do not narrate.",
  "",
  "Data model — credentials are GLOBAL, bindings are PER-SURFACE:",
  "- `credentials` is a flat registry (each entry has its own `id`). Define each distinct credential ONCE even if several surfaces accept it.",
  "- Each surface has a `type` (http | graphql | mcp | cli) and an `auth`: `required` (give `entries`), `none` (confirmed PUBLIC — give `basis.evidence`), or `unknown` (not determinable). Never leave a required surface with empty entries; use `unknown`.",
  "- An auth `entries[]` is the OR alternatives (any one works). Each entry's `use[]` is the credentials sent TOGETHER (AND), and EACH use carries its OWN `mechanics` (where that credential binds: spec | well-known | metadata | http | cli | unknown).",
  "- Detected signals are ground truth from live probes. You MUST include a surface for each detected MCP endpoint and each detected OpenAPI schema. You may set their basis to `detected` with the supplied signal, and you MUST NOT contradict detected signals.",
  "",
  "QUALITY RULES — these are the whole point; follow them exactly:",
  "1. CREDENTIALS ARE USER-MINTED ONLY. A credential is something the user creates for themselves (their API key, their OAuth app, their CLI login session). NEVER record a default, shared, factory, or example login — a self-hosted product's factory password (e.g. `admin`/`admin`) is a security footgun, not a credential. If a surface needs auth but there's no user-minted credential, use auth `unknown`.",
  "2. SELF-HOSTED ADMIN CONSOLES ARE NOT SURFACES. The web admin UI of a self-hostable product is not a public integration surface — omit it. Record only programmatic surfaces (HTTP/GraphQL APIs, MCP servers, CLIs/SDKs).",
  "3. SETUP TEXT IS A HUMAN ACQUISITION GUIDE ON THE EASIEST PATH. Write `setup` for a person acquiring the credential the simplest way. If a CLI login acquires it (`mint login`, `wrangler login`), the guide is 'run `x login`' — bind it with mechanics.source `cli` and command `x login`, and DO NOT walk through raw OAuth authorize/token/register endpoints. Endpoint detail is background at most, never the instructions.",
  "4. EVERY URL MUST COME FROM THE CORPUS. Never invent or guess a URL (generateUrl, docs, spec, url, evidence). If you didn't see it in a corpus page, don't emit it. Prefer the exact URLs the corpus shows.",
  "5. SPEC POINTERS MUST BE MACHINE-READABLE. `spec` is an OpenAPI/GraphQL SDL document URL — it must end in `.json`/`.yaml`/`.yml` or contain `openapi`/`swagger` (or be `introspection` for graphql). A docs PORTAL is not a spec; leave `spec` null and set `url` instead.",
  "6. auth `none` REQUIRES publicEvidence. Only mark a surface public when a corpus page says so — cite it in `basis.evidence`.",
  "7. OMIT SURFACE TYPES THAT DON'T EXIST. No empty placeholders. If the service has no public integration surface at all, return empty `credentials` and `surfaces`.",
  "8. FORMATTING. In `setup`, write every URL as a markdown link `[label](https://…)` and put literal values (header names, token prefixes, scopes, commands) in `backticks`.",
  "9. ONE SURFACE PER ACTUAL THING. An API published in two spec formats (`openapi.json` and `openapi.yaml`) is ONE http surface — put the JSON spec in `spec` and the other format in `specAlternates`. An MCP server reachable at one URL is ONE mcp surface regardless of how many pages mention it. Never emit two surfaces whose type and url/spec/command point at the same thing.",
  "",
  "Because this is a scrape (not a live probe), your `basis` is almost always `discovered` with the corpus URLs you read. Reserve `detected` for a genuine machine signal a corpus page reports verbatim.",
  "",
  "Study these three ideal outputs, then produce one in the same shape for the given domain:",
  "",
  fewshot("an API-key SaaS (resend)", FEWSHOT_RESEND),
  "",
  fewshot("a CLI-login service alongside a REST key (mintlify)", FEWSHOT_MINTLIFY),
  "",
  fewshot("a service with NO public API", FEWSHOT_NOAPI),
].join("\n");

// ── the user message ──────────────────────────────────────────────────────────

export interface CorpusPage {
  url: string;
  title?: string;
  content: string;
}

/** Per-page budget so a big corpus fits the context window with headroom. The
 * live loop truncates each doc to 8000 chars (PER_DOC_CHARS); with 1M ctx we
 * can afford far more, but still cap runaway pages. */
const PER_PAGE_CHARS = 24000;

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(compact).filter(hasValue);
    return items.length ? items : undefined;
  }
  if (!value || typeof value !== "object") return hasValue(value) ? value : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = compact(item);
    if (hasValue(next)) out[key] = next;
  }
  return Object.keys(out).length ? out : undefined;
}

function salientDetect(domain: string, detect: unknown): unknown {
  if (!detect || typeof detect !== "object") return undefined;
  const det = detect as Record<string, unknown>;
  const foundManifestUrls = [
    ...(Array.isArray((det.apiCatalog as { docs?: unknown } | undefined)?.docs) ? (det.apiCatalog as { docs: unknown[] }).docs : []),
    ...(Array.isArray((det.apiCatalog as { openapi?: unknown } | undefined)?.openapi) ? (det.apiCatalog as { openapi: unknown[] }).openapi : []),
    ...(Array.isArray((det.apiCatalog as { mcp?: unknown } | undefined)?.mcp) ? (det.apiCatalog as { mcp: unknown[] }).mcp : []),
    (det.apiSchema as { url?: unknown } | undefined)?.url,
    ...(Array.isArray(det.mcp) ? det.mcp.map((m) => (m as { url?: unknown })?.url) : []),
    det.llmsTxt ? `https://${domain}/llms.txt` : undefined,
  ].filter((url): url is string => typeof url === "string" && url.length > 0);

  return compact({
    found: det.found,
    foundManifestUrls,
    apiCatalog: det.apiCatalog,
    apiSchema: det.apiSchema,
    mcp: det.mcp,
    llmsTxt: det.llmsTxt,
    auth: det.auth,
  });
}

/** Assemble the user turn: the domain + the full corpus, each page delimited so
 * the model can attribute every URL it emits back to a source page. */
export function buildUserMessage(domain: string, corpus: CorpusPage[], detect?: unknown): string {
  const pages = corpus
    .map((p, i) => {
      const head = `### PAGE ${i + 1}\nURL: ${p.url}${p.title ? `\nTITLE: ${p.title}` : ""}`;
      const body = p.content.length > PER_PAGE_CHARS ? `${p.content.slice(0, PER_PAGE_CHARS)}\n…[truncated]` : p.content;
      return `${head}\nCONTENT:\n${body}`;
    })
    .join("\n\n---\n\n");
  const signals = salientDetect(domain, detect);

  return [
    `Service domain: ${domain}`,
    `Corpus: ${corpus.length} scraped page(s) below. Every URL you emit MUST appear in this corpus.`,
    "",
    "Map every credential and surface this service exposes, applying the quality rules. Output the JSON object only.",
    "",
    ...(signals ? ["DETECTED SIGNALS (authoritative — machine-verified)", JSON.stringify(signals), ""] : []),
    pages || "(the corpus is empty — return empty credentials and surfaces)",
  ].join("\n");
}
