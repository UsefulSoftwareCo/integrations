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
});

const SearchResult = Schema.Struct({
  domain: Schema.String.annotate({ description: "Registrable domain for the catalog entry." }),
  name: Schema.String.annotate({ description: "Display name for the result. Domain-level catalog results use the domain name." }),
  description: Schema.String.annotate({ description: "Short catalog description for the service or its integration surface." }),
  kinds: Schema.Array(Kind).annotate({ description: "Integration kinds currently cataloged for this domain, in canonical display order." }),
  url: Schema.String.annotate({ description: "Canonical integrations.sh page for this domain." }),
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

export function searchCatalog(query: typeof SearchQuery.Type, liveEntries: readonly LiveIndexEntry[] = []): typeof SearchResults.Type {
  const q = query.q.trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const staticIndex = searchIndex();
  const staticResults = staticIndex
    .filter((entry) => {
      if (query.kind && !entry.kinds.includes(query.kind)) return false;
      const haystack = [entry.domain, entry.description, ...entry.kinds].join(" ").toLowerCase();
      return q.length === 0 || haystack.includes(q);
    })
    .slice(0, limit)
    .map((entry) => ({
      domain: entry.domain,
      name: entry.domain,
      description: entry.description,
      kinds: entry.kinds,
      url: `https://integrations.sh/${encodeURIComponent(entry.domain)}/`,
    }));
  const results = appendLiveSearchResults(query, staticIndex, staticResults, liveEntries);
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
        const { env } = yield* ApiRuntime;
        const liveEntries = yield* Effect.promise(() => readLiveIndex(env));
        return searchCatalog(req.query, liveEntries);
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
