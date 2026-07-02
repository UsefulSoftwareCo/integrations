/** Domain-page section vocabulary. Pure constants — safe in the worker (no
 * data.ts / fs), shared by the prerendered and SSR'd domain page. */
import type { Kind } from "./types.ts";

export const KIND_ORDER = ["mcp", "openapi", "graphql", "cli"] as const;

export const SECTION_LABEL: Record<Kind, string> = {
  mcp: "MCP servers",
  openapi: "REST · OpenAPI",
  graphql: "GraphQL",
  cli: "CLI",
};

/** Short labels for the header summary line. */
export const SHORT_LABEL: Record<Kind, string> = {
  mcp: "MCP",
  openapi: "REST",
  graphql: "GraphQL",
  cli: "CLI",
};
