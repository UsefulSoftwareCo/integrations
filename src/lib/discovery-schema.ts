/**
 * The integrations.sh discovery data model (v3) as an Effect Schema — the
 * canonical, field-level definition of what the discovery agent produces, and
 * the same Schema library the worker already projects to REST + MCP + /openapi.json.
 * See docs/discovery-model.md for the prose rationale.
 *
 * Field docs live in `.annotate({ description })` (not comments) so they're
 * introspectable — they flow into the generated OpenAPI and any tooling that
 * reads the AST.
 *
 * Built from four discriminated unions (Schema.Union of Structs with a Literal
 * tag — Effect uses the tag as the discriminant):
 *   - Basis       (by `via`)    — how we learned a thing exists
 *   - Mechanics   (by `source`) — where ONE credential's binding resolves from
 *   - AuthStatus  (by `status`) — none | required | unknown, per surface
 *   - Surface     (by `type`)   — the kind of integration surface
 * `Credential` is a plain Struct whose `type` is a `Literals` enum (not a tagged
 * union) — the auth-mode vocabulary, derived from Nango (`bearer` is our own
 * addition; Nango's `NONE` lives in AuthStatus, not here).
 *
 * v3 (breaking, from v2):
 *   - `version: 3` on the result — readers dispatch on it, never shape-sniff.
 *   - every surface carries a server-assigned `slug`: its stable identity and
 *     URL segment. The model never produces it.
 *   - `openapi` and `rest` collapsed into one `http` variant (the old tag
 *     encoded "has a spec?", which `spec`'s presence already says).
 *   - Mechanics `inline` split into `http` and `cli` (one variant was carrying
 *     two unrelated key sets).
 *   - `Basis.detected` gains optional `verifiedAt` — re-verifiable facts age
 *     independently of the run that first found them.
 *   - `Basis.declared` marks surfaces/auth the site owner published via
 *     `/.well-known/integrations.json`.
 *   - `StoredDiscovery` — the KV row envelope, previously untyped and
 *     re-declared inline by every reader.
 */
import { Schema } from "effect";

/** Payload schema version. Bump on breaking shape changes. */
export const DISCOVERY_VERSION = 3 as const;

// ── Basis — how we learned a thing exists (trust/verifiability axis) ──────
export const Basis = Schema.Union([
  Schema.Struct({
    via: Schema.Literal("detected"),
    signal: Schema.String.annotate({ description: "A re-verifiable machine signal the service publishes (e.g. '.well-known/api-catalog', 'oauth-protected-resource', 'openapi:securitySchemes')." }),
    verifiedAt: Schema.optional(Schema.String.annotate({ description: "ISO timestamp the signal was last re-verified — detected facts age independently of the run that first found them." })),
  }),
  Schema.Struct({
    via: Schema.Literal("discovered"),
    evidence: Schema.Array(Schema.String).annotate({ description: "Doc URLs the agent read to confirm this. Point-in-time, prose-derived." }),
  }),
  Schema.Struct({
    via: Schema.Literal("declared"),
    source: Schema.String.annotate({ description: "The owner-published integrations.json URL that declared this surface or auth entry." }),
  }),
]).annotate({ description: "How we learned a thing exists. `detected` = asserted by a machine signal (high trust, re-verifiable); `discovered` = the agent read it from docs; `declared` = published by the site owner." });

// ── Mechanics — how a credential binds to a surface (where it resolves from) ───
export const Mechanics = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("spec"),
    scheme: Schema.String.annotate({ description: "The OpenAPI securityScheme NAME this one credential satisfies (the AND of multiple is carried by AuthEntry.use, not here)." }),
  }),
  Schema.Struct({
    source: Schema.Literal("well-known"),
  }).annotate({ description: "Derives from the surface `url` via RFC 9728/8414 (MCP OAuth). Nothing to store — re-resolvable." }),
  Schema.Struct({
    source: Schema.Literal("metadata"),
    url: Schema.String.annotate({ description: "The non-standard location of the well-known metadata (an override)." }),
  }),
  Schema.Struct({
    source: Schema.Literal("http"),
    in: Schema.optional(Schema.Literals(["header", "query", "body", "path"]).annotate({ description: "Where the credential rides. Default: header." })),
    headerName: Schema.optional(Schema.String.annotate({ description: "HTTP header name, e.g. 'Authorization'." })),
    scheme: Schema.optional(Schema.String.annotate({ description: "HTTP auth scheme prefix, e.g. 'Bearer'." })),
    paramName: Schema.optional(Schema.String.annotate({ description: "Query/body parameter name." })),
  }).annotate({ description: "Agent-read from docs: the credential rides on the HTTP request itself." }),
  Schema.Struct({
    source: Schema.Literal("cli"),
    command: Schema.optional(Schema.String.annotate({ description: "A command to run, e.g. 'wrangler login'." })),
    env: Schema.optional(Schema.Array(Schema.String).annotate({ description: "Env var(s) to set, e.g. ['CLOUDFLARE_API_TOKEN']." })),
  }).annotate({ description: "Agent-read from docs: the credential enters through a CLI login flow or environment variables." }),
  Schema.Struct({
    source: Schema.Literal("unknown"),
  }).annotate({ description: "Confirmed to exist, but the binding mechanics weren't captured." }),
]).annotate({ description: "How a credential binds to a surface. `source` also signals knowledge state: spec/well-known/metadata/http/cli = known; unknown = unresolved." });

// ── Credential — what it is + where you get it (defined once, by id) ───────────

/** Auth-mode vocabulary, derived from Nango (not an exact mirror): `bearer` is
 * our refinement; Nango's `NONE` is modeled by AuthStatus, not as a credential.
 * Exotic types (app/two_step/signature/aws_sigv4) are NAMED but not executed —
 * the flow lives in `setup`; mechanics stays http/cli/unknown. */
export const CredentialType = Schema.Literals([
  "api_key",
  "basic",
  "bearer",
  "oauth2",
  "oauth2_cc", // OAuth client-credentials
  "oauth1",
  "jwt", // signed-JWT bearer (RFC 7523)
  "app", // GitHub-App style (compound + JWT->token exchange)
  "two_step", // token exchange (STS, etc.)
  "signature", // request signing (generic)
  "aws_sigv4", // AWS SigV4
  "tba", // token-based auth (Netsuite-style)
  "compound", // a named bundle of sub-secrets
  "custom",
]).annotate({ description: "The credential strategy (Nango-derived). Exotic modes are named but executed lazily (the flow is in `setup`)." });

export const Credential = Schema.Struct({
  type: CredentialType,
  label: Schema.String.annotate({ description: "Human label, e.g. 'Cloudflare API token'." }),
  generateUrl: Schema.optional(Schema.String.annotate({ description: "Where the user mints/registers the credential." })),
  setup: Schema.String.annotate({ description: "Markdown: the human acquisition guide — where to go, what to click, gotchas." }),
  acquisition: Schema.optional(Schema.Literals(["manual", "ambient"]).annotate({ description: "manual (default) | ambient (env-injected, e.g. CI tokens — no acquisition step)." })),
  fields: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ secret: Schema.optional(Schema.Boolean), description: Schema.optional(Schema.String) }),
    ).annotate({ description: "Named sub-secrets for ANY inherently multi-part credential (compound, app/GitHub-App's appId+privateKey+clientId+clientSecret, a basic email+token pair). Absent when the credential is a single secret." }),
  ),
}).annotate({ description: "A credential the service issues — what it is and where you get it. Defined ONCE in the registry; referenced by surface auth via id." });

// ── Auth — one binding of one credential; entries (OR) of uses (AND) ───────────

/** One credential bound to a surface, with ITS OWN mechanics. Lives in an
 * AuthEntry's `use[]`; multiple uses in an entry are AND'd, each placed
 * independently (e.g. app-id in one header, api-key in another). */
export const CredentialUse = Schema.Struct({
  id: Schema.String.annotate({ description: "References `credentials[id]`." }),
  mechanics: Mechanics,
}).annotate({ description: "One credential and how THIS credential is bound on this surface." });

export const AuthEntry = Schema.Struct({
  use: Schema.Array(CredentialUse).annotate({ description: "Credentials sent TOGETHER (AND) for this one way in — each with its own placement." }),
  basis: Basis,
}).annotate({ description: "One way to authenticate to a surface. Sibling entries are OR alternatives (any one works)." });

/** Whether a surface needs auth — and the difference between confirmed-public
 * and not-yet-figured-out, which `auth: []` couldn't express. */
export const AuthStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("none"),
    basis: Basis,
  }).annotate({ description: "Confirmed public — no credential needed. `basis.via:detected` (a probe got a clean unauthenticated response) outranks `discovered` (the docs said so)." }),
  Schema.Struct({
    status: Schema.Literal("required"),
    entries: Schema.Array(AuthEntry).annotate({ description: "OR alternatives — at least one is needed." }),
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
  }).annotate({ description: "Auth not yet determined (NOT the same as public)." }),
]).annotate({ description: "A surface's auth requirement: none | required | unknown." });

// ── Surface — one integration surface (discriminated on `type`) ────────────────

const RequiredHeader = Schema.Struct({
  name: Schema.String,
  // Exactly one source — a literal value or an env var, never both/neither.
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("static"), value: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("env"), envVar: Schema.String }),
  ]),
  description: Schema.optional(Schema.String),
}).annotate({ description: "A mandatory non-auth header (e.g. a version pin like anthropic-version)." });

const Variable = Schema.Struct({
  name: Schema.String.annotate({ description: "A token substituted wherever `{name}` appears in the surface url (e.g. {project_ref} → {project_ref}.supabase.co)." }),
  in: Schema.optional(Schema.Literals(["url", "header", "query"]).annotate({ description: "Default 'url' (templated into the url, incl. hostname). Set only when it goes elsewhere." })),
  resolveFrom: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
}).annotate({ description: "An instance/region identifier needed to build the request (project_ref, cloudId)." });

/** Fields shared across every surface kind. */
const surfaceBase = {
  slug: Schema.String.annotate({
    description:
      "Stable identity and URL segment (/{domain}/{slug}/). Assigned SERVER-SIDE at record time " +
      "(slugified name, deduped within the result) — the model never produces it. On re-discovery, " +
      "a surface matching a previous one by locator (url/spec/command) KEEPS its prior slug even if " +
      "renamed, so links never break.",
  }),
  name: Schema.String.annotate({ description: "Display name. NOT identity — may change across runs; `slug` is the stable key." }),
  docs: Schema.optional(Schema.String.annotate({ description: "Human docs URL." })),
  basis: Basis,
  auth: AuthStatus,
  requiredHeaders: Schema.optional(Schema.Array(RequiredHeader)),
  variables: Schema.optional(Schema.Array(Variable)),
  notes: Schema.optional(Schema.String),
};

export const Surface = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    spec: Schema.optional(Schema.String.annotate({ description: "OpenAPI doc URL — a POINTER, never inlined. Absent = specless REST; auth mechanics are then http/unknown, not spec." })),
    specAlternates: Schema.optional(Schema.Array(Schema.String).annotate({ description: "Additional machine-readable spec documents for the SAME API in other formats (e.g. the YAML twin of a JSON OpenAPI doc)." })),
    url: Schema.optional(Schema.String.annotate({ description: "Base URL — when there's no spec, or not derivable from the spec's `servers`." })),
    patch: Schema.optional(Schema.Unknown.annotate({ description: "securityScheme overrides for when the spec is wrong or missing a scheme." })),
    ...surfaceBase,
  }).annotate({ description: "A REST/HTTP API, with or without an OpenAPI spec (spec present ⇒ machine-readable)." }),
  Schema.Struct({
    type: Schema.Literal("graphql"),
    url: Schema.optional(Schema.String.annotate({ description: "Expected — a GraphQL schema has no endpoint, so this is how you reach it." })),
    spec: Schema.optional(Schema.String.annotate({ description: "'introspection' or an SDL URL." })),
    specAlternates: Schema.optional(Schema.Array(Schema.String).annotate({ description: "Additional machine-readable spec documents for the SAME API in other formats (e.g. the YAML twin of a JSON OpenAPI doc)." })),
    ...surfaceBase,
  }),
  Schema.Struct({
    type: Schema.Literal("mcp"),
    url: Schema.optional(Schema.String.annotate({ description: "The MCP connect endpoint (NOT a docs page)." })),
    transports: Schema.optional(Schema.Array(Schema.String).annotate({ description: "streamable-http | sse (server.json `remotes[].type`)." })),
    ...surfaceBase,
  }),
  Schema.Struct({
    type: Schema.Literal("cli"),
    packages: Schema.optional(
      Schema.Array(
        Schema.Struct({
          registryType: Schema.String.annotate({ description: "npm | pypi | oci | brew | …" }),
          identifier: Schema.String,
          runtimeHint: Schema.optional(Schema.String.annotate({ description: "npx | uvx | …" })),
        }),
      ).annotate({ description: "Install options (server.json `packages` shape)." }),
    ),
    command: Schema.optional(Schema.String.annotate({ description: "The command name, e.g. 'wrangler'." })),
    ...surfaceBase,
  }),
]).annotate({ description: "One integration surface. Per-`type` fields: http carries spec/url/patch; graphql carries url+spec; mcp carries url+transports; cli carries packages+command." });

// ── Top-level result ───────────────────────────────────────────────────────────
export const DiscoveryResult = Schema.Struct({
  version: Schema.Literal(DISCOVERY_VERSION).annotate({ description: "Payload schema version. Readers dispatch on this — never shape-sniff." }),
  domain: Schema.String,
  summary: Schema.String.annotate({ description: "One-line overview of the service's integration surface." }),
  description: Schema.optional(Schema.String.annotate({ description: "Plain factual description of what the service/product does, for registry listings." })),
  discoveredAt: Schema.optional(Schema.String.annotate({ description: "ISO timestamp this result was produced — for staleness of `discovered` facts (detected facts carry their own verifiedAt)." })),
  credentials: Schema.Record(Schema.String, Credential).annotate({ description: "Global credential registry, keyed by id — defined once, referenced by surface auth." }),
  surfaces: Schema.Array(Surface).annotate({ description: "Typed surface inventory (http/graphql/mcp/cli)." }),
}).annotate({ description: "The integrations.sh discovery result (v3): a global credential registry + a typed list of surfaces." });

/** Owner-authored subset accepted at `/.well-known/integrations.json`.
 * Nested values use the exact same wire schemas as DiscoveryResult v3; the
 * domain and discoveredAt/model envelope remain registry-owned. */
export const OwnerDeclaredDiscovery = Schema.Struct({
  version: Schema.Literal(DISCOVERY_VERSION),
  summary: Schema.optional(Schema.String),
  credentials: Schema.optional(Schema.Record(Schema.String, Credential)),
  surfaces: Schema.optional(Schema.Array(Surface)),
}).annotate({ description: "Owner-authored subset of DiscoveryResult v3 accepted at /.well-known/integrations.json." });

/** The KV row for a domain — the ONE envelope entry.ts writes and every
 * render-time reader (surface page, SSR domain page, /api/{domain}/discovery)
 * parses. Previously untyped and re-declared inline by each consumer. */
export const StoredDiscovery = Schema.Struct({
  result: DiscoveryResult,
  discoveredAt: Schema.String.annotate({ description: "When this row was written." }),
  model: Schema.String.annotate({ description: "The model that produced it (or 'cache-backfill')." }),
});

// ── Inferred types (single source of truth — replace the hand-written interfaces) ──
export type Basis = typeof Basis.Type;
export type Mechanics = typeof Mechanics.Type;
export type Credential = typeof Credential.Type;
export type CredentialType = typeof CredentialType.Type;
export type CredentialUse = typeof CredentialUse.Type;
export type AuthEntry = typeof AuthEntry.Type;
export type AuthStatus = typeof AuthStatus.Type;
export type Surface = typeof Surface.Type;
export type DiscoveryResult = typeof DiscoveryResult.Type;
export type OwnerDeclaredDiscovery = typeof OwnerDeclaredDiscovery.Type;
export type StoredDiscovery = typeof StoredDiscovery.Type;
