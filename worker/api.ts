/**
 * The API — the single source of truth.
 *
 * Endpoints are defined once as an Effect `HttpApi`; the typed server, the
 * OpenAPI document (`/openapi.json`), and downstream artifacts (MCP, CLI) all
 * derive from this. Runs as a pure web fetch handler on Cloudflare Workers.
 */
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Etag, HttpPlatform } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { detect } from "../src/lib/detect.ts";

// Response shape (top-level typed; per-format detail kept loose for now).
const DetectionResult = Schema.Struct({
  domain: Schema.String,
  found: Schema.Array(Schema.String),
  apiCatalog: Schema.optional(Schema.Unknown),
  apiSchema: Schema.optional(Schema.Unknown),
  mcp: Schema.Array(Schema.Unknown),
  agentCard: Schema.optional(Schema.Unknown),
  agentSkills: Schema.optional(Schema.Unknown),
  llmsTxt: Schema.Boolean,
  errors: Schema.Array(Schema.String),
});

const Detect = HttpApiEndpoint.get("detect", "/api/:domain/detect", {
  params: Schema.Struct({ domain: Schema.String }),
  success: DetectionResult,
});

export const Api = HttpApi.make("integrations.sh").add(
  HttpApiGroup.make("detect").add(Detect),
);

const DetectGroup = HttpApiBuilder.group(Api, "detect", (handlers) =>
  handlers.handle("detect", (req: { readonly params: { readonly domain: string } }) =>
    Effect.promise(() => detect(req.params.domain.trim().toLowerCase()) as Promise<typeof DetectionResult.Type>),
  ),
);

const Platform = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(DetectGroup),
  Layer.provide(Platform),
);

const built = HttpRouter.toWebHandler(ApiLive as never);
export const apiHandler = built.handler as (req: Request) => Promise<Response>;
