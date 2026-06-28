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

export const DetectParams = Schema.Struct({ domain: Schema.String });

export const DetectionResult = Schema.Struct({
  domain: Schema.String,
  found: Schema.Array(Schema.String),
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
  "Detect a domain's agent-readiness: well-known manifests (api-catalog, MCP " +
  "server-card, agent-card, agent-skills, llms.txt) plus live capability " +
  "detection — MCP self-onboarding (DCR/CIMD) and the live OpenAPI schema.";

/** The detect handler, shared by REST and MCP. */
export const runDetect = (domain: string): Effect.Effect<typeof DetectionResult.Type> =>
  Effect.promise(() => detect(domain.trim().toLowerCase()) as Promise<typeof DetectionResult.Type>);
