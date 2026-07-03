/**
 * Operations — the single source of truth, written once.
 *
 * Each operation's input schema, output schema, description, and handler live
 * here exactly once. The REST API (worker/api.ts → also emits /openapi.json) and
 * the MCP server (worker/registry.ts) are both projected from these — sharing
 * the Effect Schema directly rather than round-tripping through OpenAPI (lossless,
 * fully typed, since both transports are Effect).
 */
import { Effect, Schema } from "effect";
import { detect } from "../src/lib/detect.ts";
import { discover, type ChatFn, type DiscoverEvent, type WebBackend } from "../src/lib/discover.ts";
import { naiveWeb } from "../src/lib/contextdev.ts";
import { Credential, CredentialType, DISCOVERY_VERSION, Surface } from "../src/lib/discovery-schema.ts";
import { canonicalDomain } from "../src/lib/domain-aliases.ts";

export const DetectParams = Schema.Struct({ domain: Schema.String });

export const DetectionResult = Schema.Struct({
  domain: Schema.String,
  found: Schema.Array(Schema.String),
  probed: Schema.optional(Schema.Array(Schema.String)),
  integrationsJson: Schema.optional(Schema.NullOr(Schema.Unknown)),
  apiCatalog: Schema.optional(Schema.Unknown),
  apiSchema: Schema.optional(Schema.Unknown),
  auth: Schema.optional(Schema.Unknown),
  mcp: Schema.Array(Schema.Unknown),
  agentCard: Schema.optional(Schema.Unknown),
  agentSkills: Schema.optional(Schema.Unknown),
  llmsTxt: Schema.Boolean,
  errors: Schema.Array(Schema.String),
});

export const DETECT_DESCRIPTION =
  "Detect a domain's agent-readiness: well-known manifests (integrations.json, api-catalog, MCP " +
  "server-card, agent-card, agent-skills, llms.txt) plus live capability " +
  "detection — MCP self-onboarding (DCR/CIMD) and the live OpenAPI schema.";

/** The detect handler, shared by REST and MCP. JSON-cleans the result so the
 * Schema.Unknown response encoder never sees an explicit `undefined` (not a
 * valid JSON value). */
export const runDetect = (domain: string): Effect.Effect<typeof DetectionResult.Type> =>
  Effect.promise(async () => {
    const r = await detect(canonicalDomain(domain));
    return JSON.parse(JSON.stringify(r)) as typeof DetectionResult.Type;
  });

// ── discover: the LLM long-tail fallback ──────────────────────────────────────

export const DiscoverParams = Schema.Struct({ domain: Schema.String });

export const DiscoverResult = Schema.Struct({
  /** Payload schema version (v3) — readers dispatch on it, never shape-sniff. */
  version: Schema.Literal(DISCOVERY_VERSION),
  domain: Schema.String,
  /** The full deterministic detection result (always run first, seeds the agent). */
  detect: Schema.Unknown,
  /** One-line summary of the service's integration surface. */
  summary: Schema.optional(Schema.String),
  /** Plain factual description of what the service/product does. */
  description: Schema.optional(Schema.String),
  /** ISO timestamp this result was produced. */
  discoveredAt: Schema.String,
  /** Global credential registry, keyed by id — the CANONICAL Credential schema,
   * so /openapi.json and the MCP tool result publish the full annotated model. */
  credentials: Schema.optional(Schema.Record(Schema.String, Credential)),
  /** Typed surface inventory (http/graphql/mcp/cli), each with a stable slug
   * and auth entries referencing credentials. */
  surfaces: Schema.optional(Schema.Array(Surface)),
  /** Whether the LLM agent ran (false = no model binding available). */
  usedLlm: Schema.Boolean,
});

export const DISCOVER_DESCRIPTION =
  "Map a domain's complete public integration surface for agents — MCP servers, REST/OpenAPI, " +
  "GraphQL, CLIs, SDKs, webhooks — plus how to authenticate (per method: where to get the " +
  "credential and how to pass it). Runs deterministic detection first to seed authoritative " +
  "signals, then a bounded model-driven agent (web search, sitemap, JS-rendered scrape) maps the " +
  "rest. Returns pointers (spec/docs URLs), never parsed specs.";

/** The injected chat model (OpenAI tool-calling). Set by the Worker per isolate;
 * null in Bun/tests, where the agent is skipped. */
let chatFn: ChatFn | null = null;
export const setChat = (fn: ChatFn | null): void => {
  chatFn = fn;
};

/** The injected web backend (context.dev when a key is wired, else naive fetch).
 * Set by the Worker per isolate. */
let webBackend: WebBackend | null = null;
export const setWebBackend = (b: WebBackend): void => {
  webBackend = b;
};

/** The engine's Credential.type is a free string (the model writes it);
 * the wire schema is the CredentialType enum. Coerce off-vocabulary → custom. */
const CRED_TYPES = new Set<string>(CredentialType.literals);
const coerceCredentials = (creds: Record<string, { type: string }> | undefined) => {
  if (!creds) return undefined;
  return Object.fromEntries(
    Object.entries(creds).map(([id, c]) => [id, { ...c, type: CRED_TYPES.has(c.type) ? c.type : "custom" }]),
  );
};

/** A surface's locator — the stable thing it points at, independent of its
 * display name. Used to carry slugs across re-discovery. */
type SlugSurface = {
  slug: string;
  type: string;
  url?: string;
  spec?: string;
  command?: string;
  packages?: readonly { identifier?: string }[];
};

export const locatorOf = (s: SlugSurface): string | undefined => {
  const loc = s.type === "cli" ? (s.command ?? s.packages?.[0]?.identifier) : (s.url ?? s.spec);
  return loc ? `${s.type}|${loc.toLowerCase()}` : undefined;
};

/** Slug continuity: a fresh result's surface that matches a PRIOR surface by
 * locator keeps the prior slug, even if the model renamed it — /{domain}/{slug}/
 * links never break across re-runs. Collisions re-suffix deterministically. */
export function preserveSlugs<T extends SlugSurface>(surfaces: T[], prior: readonly SlugSurface[]): void {
  const bySlugLoc = new Map<string, string>();
  for (const p of prior) {
    const loc = locatorOf(p);
    if (loc && p.slug) bySlugLoc.set(loc, p.slug);
  }
  const taken = new Set<string>();
  for (const s of surfaces) {
    const loc = locatorOf(s);
    const inherited = loc ? bySlugLoc.get(loc) : undefined;
    let slug = inherited ?? s.slug;
    const base = slug || "surface";
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    s.slug = slug;
    taken.add(slug);
  }
}

/** Flatten the engine's DiscoveryResult into the JSON-clean wire shape (v3:
 * versioned; a global credentials registry + a typed, slugged surfaces list). */
export const packDiscovery = (domain: string, detect: unknown, disc: Awaited<ReturnType<typeof discover>>, usedLlm: boolean) =>
  JSON.parse(
    JSON.stringify({
      version: DISCOVERY_VERSION,
      domain,
      detect,
      usedLlm,
      discoveredAt: new Date().toISOString(),
      summary: disc?.summary,
      description: disc?.description,
      credentials: coerceCredentials(disc?.credentials),
      surfaces: disc?.surfaces,
    }),
  );

/** The discover handler, shared by REST and MCP. Detect-first to seed the agent
 * with authoritative signals; the model then drives its own discovery trajectory. */
export const runDiscover = (domain: string): Effect.Effect<typeof DiscoverResult.Type> =>
  Effect.promise(async () => {
    const d = await detect(canonicalDomain(domain));
    if (!chatFn) return packDiscovery(d.domain, d, null, false);
    const disc = await discover(d.domain, d, chatFn, webBackend ?? naiveWeb()).catch(() => null);
    return packDiscovery(d.domain, d, disc, true);
  });

/** Same pipeline as runDiscover, but emits events as it goes — status `progress`
 * plus `credential`/`surface` partials the moment the agent records each. Used by
 * the Worker's SSE stream endpoint; returns the JSON-clean result so the stream
 * can also warm the edge cache. */
export const discoverWithProgress = async (
  domain: string,
  emit: (event: DiscoverEvent) => void,
): Promise<typeof DiscoverResult.Type> => {
  emit({ kind: "progress", message: "Checking well-known endpoints…" });
  const d = await detect(canonicalDomain(domain));
  emit({ kind: "progress", message: d.found.length ? `Detected: ${d.found.join(", ")}` : "No standard signals — searching" });
  if (!chatFn) return packDiscovery(d.domain, d, null, false);
  const disc = await discover(d.domain, d, chatFn, webBackend ?? naiveWeb(), emit).catch(() => null);
  return packDiscovery(d.domain, d, disc, true);
};
