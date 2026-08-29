/**
 * The REST API — defined once as an Effect HttpApi. The typed server and the
 * OpenAPI document (/openapi.json) both derive from this. Runs as a pure web
 * fetch handler on Cloudflare Workers.
 */
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Etag, HttpPlatform } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { Credential, DISCOVERY_VERSION, Surface } from "../src/lib/discovery-schema.ts";
import { canonicalDomain } from "../src/lib/domain-aliases.ts";
import { searchIndex } from "../src/lib/search-index.ts";
import type { Env } from "./env.ts";
import { discoveryDoc } from "./discovery-doc.ts";
import { appendLiveSearchResults, readLiveIndex, type LiveIndexEntry } from "./live-index.ts";
import {
  DETECT_DESCRIPTION,
  DetectionResult,
  DetectParams,
  DISCOVER_DESCRIPTION,
  DiscoverParams,
  DiscoverResult,
  runDetect,
  runDiscover,
} from "./operations.ts";

export class ApiRuntime extends Context.Service<ApiRuntime, { readonly env: Env; readonly origin: string }>()(
  "integrations.sh/ApiRuntime",
) {}

export const apiContext = (env: Env, origin: string): Context.Context<ApiRuntime> =>
  Context.make(ApiRuntime, { env, origin });

const Kind = Schema.Literals(["mcp", "openapi", "graphql", "cli"]);

const SearchQuery = Schema.Struct({
  q: Schema.String.annotate({ description: "Required search text. Matches catalog domains, descriptions, and available surface kinds." }),
  kind: Schema.optional(
    Kind.annotate({ description: "Limit results to domains that expose this kind of integration surface." }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
      description: "Maximum number of results to return. Defaults to 20 and cannot exceed 100.",
    }),
  ),
  offset: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description:
        "Number of ranked results to skip, for paging through a long result set. Defaults to 0.",
    }),
  ),
});

const SearchSurface = Schema.Struct({
  kind: Kind.annotate({ description: "The kind of integration surface." }),
  slug: Schema.String.annotate({
    description:
      "Stable registry identifier for this surface. Record it to recognise later that you already added this integration — the domain is not that identifier, since a vendor's surfaces can live on other hosts (GitHub's MCP server is on api.githubcopilot.com).",
  }),
  url: Schema.optional(
    Schema.String.annotate({
      description:
        "What to point at to connect this surface: the MCP endpoint, the OpenAPI spec URL, or the GraphQL endpoint. Absent when the registry has no machine-readable locator on record.",
    }),
  ),
  icon: Schema.optional(
    Schema.String.annotate({
      description:
        "A hand-picked product mark for this surface (e.g. Google Calendar's own logo), when it represents the product better than the domain favicon.",
    }),
  ),
  specOverrides: Schema.optional(
    Schema.Array(Schema.Unknown).annotate({
      description:
        "RFC 6902 JSON Patch operations to apply to the fetched spec before use. How the registry improves a vendor's published document without hosting a fork — e.g. removing console session-cookie security schemes that are not real credentials.",
    }),
  ),
  auth: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(
        Schema.String.annotate({ description: "Credential kind: api_key, oauth, …" }),
      ),
      header: Schema.optional(
        Schema.String.annotate({
          description:
            "Header pattern for the credential, e.g. \"Authorization: Bearer {token}\" — or \"Authorization: {api_key}\" for APIs like Linear whose keys take no Bearer prefix.",
        }),
      ),
      note: Schema.optional(
        Schema.String.annotate({ description: "One-line human note about the credential." }),
      ),
    }).annotate({
      description:
        "How to authenticate this surface, for kinds whose connect target cannot describe it itself (GraphQL endpoints have no spec document).",
    }),
  ),
});

const SearchResult = Schema.Struct({
  domain: Schema.String.annotate({ description: "Registrable domain for the catalog entry." }),
  name: Schema.String.annotate({ description: "Display name for the result. Domain-level catalog results use the domain name." }),
  description: Schema.String.annotate({ description: "Short catalog description for the service or its integration surface." }),
  kinds: Schema.Array(Kind).annotate({ description: "Integration kinds currently cataloged for this domain, in canonical display order." }),
  url: Schema.String.annotate({ description: "Canonical integrations.sh page for this domain." }),
  surfaces: Schema.optional(
    Schema.Array(SearchSurface).annotate({
      description:
        "Per-kind connect targets, so a client can connect (and recognise what it has already connected) without a second request for the domain's surface document.",
    }),
  ),
});

const SearchResults = Schema.Struct({
  results: Schema.Array(SearchResult),
});

const SurfaceNotFound = Schema.Struct({
  error: Schema.String.annotate({ description: "Surface document lookup failure." }),
}).pipe(HttpApiSchema.status(404)).annotate({ description: "No stored or baseline surface document exists for the domain." });

const SurfaceResult = Schema.Struct({
  version: Schema.Literal(DISCOVERY_VERSION),
  domain: Schema.String,
  detect: Schema.optional(Schema.Unknown),
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  discoveredAt: Schema.optional(Schema.String),
  credentials: Schema.optional(Schema.Record(Schema.String, Credential)),
  surfaces: Schema.Array(Surface),
  usedLlm: Schema.optional(Schema.Boolean),
});

const SEARCH_DESCRIPTION =
  "Search the integrations.sh catalog for domains that expose agent-ready integration surfaces. " +
  "Use `q` for the user's search text, optionally narrow to one surface kind, and tune `limit` " +
  "when building typeahead or command discovery. Results are domain-level and sorted with the " +
  "same ranking as the homepage: curated developer tools first, then popularity, then total " +
  "cataloged surfaces.";

const SURFACE_DESCRIPTION =
  "Return the integration surface document that powers a domain page. The durable discovery result " +
  "from KV wins when it exists; otherwise the endpoint returns the bundled baseline discovery JSON " +
  "for that domain. The response lists the service's MCP, REST/OpenAPI, GraphQL, and CLI surfaces " +
  "with stable slugs and authentication metadata. A 404 means integrations.sh has no stored or " +
  "baseline surface document for the domain.";

const SEARCH_LIMIT_PARAMETER_SCHEMA = {
  type: "integer",
  format: "int32",
  minimum: 1,
  maximum: 100,
  default: 20,
  description: "Maximum number of results to return. Defaults to 20 and cannot exceed 100.",
};

function applyCatalogOpenApiOverrides(spec: Record<string, any>): Record<string, any> {
  const params = spec.paths?.["/api/search"]?.get?.parameters;
  if (Array.isArray(params)) {
    const limit = params.find((param) => param?.name === "limit" && param?.in === "query");
    if (limit) limit.schema = SEARCH_LIMIT_PARAMETER_SCHEMA;
  }
  return spec;
}

const Search = HttpApiEndpoint.get("search", "/api/search", {
  query: SearchQuery,
  success: SearchResults,
})
  .annotate(OpenApi.Identifier, "search")
  .annotate(OpenApi.Summary, "Search the integrations.sh catalog")
  .annotate(OpenApi.Description, SEARCH_DESCRIPTION);

const Detect = HttpApiEndpoint.get("detect", "/api/:domain/detect", {
  params: DetectParams,
  success: DetectionResult,
})
  .annotate(OpenApi.Summary, "Detect a domain's agent-readiness")
  .annotate(OpenApi.Description, DETECT_DESCRIPTION);

const Discover = HttpApiEndpoint.get("discover", "/api/:domain/discover", {
  params: DiscoverParams,
  success: DiscoverResult,
})
  .annotate(OpenApi.Summary, "Discover how to authenticate with a domain's API")
  .annotate(OpenApi.Description, DISCOVER_DESCRIPTION);

const SurfaceEndpoint = HttpApiEndpoint.get("surface", "/api/:domain/surface", {
  params: DetectParams,
  success: SurfaceResult,
  error: SurfaceNotFound,
})
  .annotate(OpenApi.Identifier, "surface")
  .annotate(OpenApi.Summary, "Get a domain's integration surface document")
  .annotate(OpenApi.Description, SURFACE_DESCRIPTION);

const CANONICAL_ORIGIN = "https://integrations.sh";
const CANONICAL_HOST = "integrations.sh";

/** Self-hosted assets (spec mirrors under /specs/) keep working when the
 *  worker serves from another HOST — a workers.dev preview, a fork — by
 *  pointing at the origin that answered the search. Compared by host, not
 *  origin string: wrangler dev emulates the canonical domain over http, and a
 *  scheme-only difference must not downgrade canonical URLs. */
const surfaceUrlForOrigin = (url: string | undefined, origin: string): string | undefined => {
  if (url === undefined || !url.startsWith(`${CANONICAL_ORIGIN}/specs/`)) return url;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL() rejects malformed origins; keep the canonical URL then
  try {
    if (origin === "" || new URL(origin).hostname === CANONICAL_HOST) return url;
  } catch {
    return url;
  }
  return `${origin}${url.slice(CANONICAL_ORIGIN.length)}`;
};

export function searchCatalog(query: typeof SearchQuery.Type, liveEntries: readonly LiveIndexEntry[] = [], origin = ""): typeof SearchResults.Type {
  const q = query.q.trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const staticIndex = searchIndex();
  const matches = staticIndex.filter((entry) => {
    if (query.kind && !entry.kinds.includes(query.kind)) return false;
    const haystack = [entry.domain, entry.name ?? "", entry.description, ...entry.kinds].join(" ").toLowerCase();
    return q.length === 0 || haystack.includes(q);
  });
  // What the entry is called beats what its description happens to mention:
  // "teams" should surface Teams Chats before every service whose blurb says
  // it is "built for teams". Index order (ranking) is preserved within each.
  const named = (entry: (typeof matches)[number]) => `${entry.domain} ${entry.name ?? ""}`.toLowerCase().includes(q);
  const staticResults = (q.length === 0 ? matches : [...matches.filter(named), ...matches.filter((entry) => !named(entry))])
    .map((entry) => ({
      domain: entry.domain,
      name: entry.name ?? entry.domain,
      description: entry.description,
      kinds: entry.kinds,
      url: `https://integrations.sh/${encodeURIComponent(entry.domain)}/`,
      ...(entry.surfaces && entry.surfaces.length > 0
        ? {
            surfaces: (query.kind
              ? entry.surfaces.filter((surface) => surface.kind === query.kind)
              : entry.surfaces
            ).map((surface) => {
              const url = surfaceUrlForOrigin(surface.url, origin);
              // Never reintroduce the key: an explicit `url: undefined`
              // encodes as null, which is not an optional string.
              const { url: _dropped, ...rest } = surface;
              return { ...rest, ...(url !== undefined ? { url } : {}) };
            }),
          }
        : {}),
    }));
  // Page over the COMBINED ranked list — static matches then live discoveries
  // — so an offset deep into the catalog pages seamlessly into live rows.
  const offset = Math.max(query.offset ?? 0, 0);
  const results = appendLiveSearchResults(query, staticIndex, staticResults, liveEntries).slice(
    offset,
    offset + limit,
  );
  return { results };
}

export const Api = HttpApi.make("integrations.sh")
  .add(HttpApiGroup.make("detect", { topLevel: true }).add(Search).add(Detect).add(Discover).add(SurfaceEndpoint))
  .annotate(OpenApi.Title, "integrations.sh")
  .annotate(OpenApi.Version, "0.1.0")
  .annotate(
    OpenApi.Description,
    "Discover how to integrate with any service — APIs, MCP servers, GraphQL, CLIs — and detect what a domain exposes to agents.",
  )
  .annotate(OpenApi.Transform, applyCatalogOpenApiOverrides);

const DetectGroup = HttpApiBuilder.group(Api, "detect", (handlers) =>
  handlers
    .handle("search", (req: { readonly query: typeof SearchQuery.Type }) =>
      Effect.gen(function*() {
        const { env, origin } = yield* ApiRuntime;
        const liveEntries = yield* Effect.promise(() => readLiveIndex(env));
        return searchCatalog(req.query, liveEntries, origin);
      }))
    .handle("detect", (req: { readonly params: { readonly domain: string } }) => runDetect(canonicalDomain(req.params.domain)))
    .handle("discover", (req: { readonly params: { readonly domain: string } }) => runDiscover(canonicalDomain(req.params.domain)))
    .handle("surface", (req: { readonly params: { readonly domain: string } }) =>
      Effect.gen(function*() {
        const { env, origin } = yield* ApiRuntime;
        const domain = canonicalDomain(req.params.domain);
        const doc = yield* Effect.promise(() => discoveryDoc(env, origin, domain));
        if (!doc) return yield* Effect.fail({ error: "surface not found" } as typeof SurfaceNotFound.Type);
        return JSON.parse(JSON.stringify(doc)) as typeof SurfaceResult.Type;
      })),
);

const Platform = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(DetectGroup),
  Layer.provide(Platform),
);

const built = HttpRouter.toWebHandler(ApiLive as never);
export const apiHandler = built.handler as (
  req: Request,
  context?: Context.Context<ApiRuntime>,
) => Promise<Response>;
