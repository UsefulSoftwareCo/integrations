export type Kind = "mcp" | "openapi" | "graphql" | "cli";

/** Display formats. Superset of Kind: curated providers can also expose CLIs. */
export type Format = "mcp" | "openapi" | "graphql" | "cli";

export type Feed =
  | "claude"
  | "openai"
  | "apis-guru"
  | "graphql-apis"
  | "override"
  | "cli-seed"
  | "discovered"
  /** Hand-verified records in `curated/`. Highest confidence: a human checked
   *  what the vendor actually exposes. */
  | "curated";

export interface Integration {
  id: string;
  kind: Kind;
  slug: string;
  name: string;
  /** A product in its own right on a shared vendor domain (Microsoft Graph's
   *  workloads all live on graph.microsoft.com). Standalone records get their
   *  own search row instead of merging into the domain's per-kind surface set. */
  standalone?: boolean;
  description: string;
  url?: string;
  icon?: string;
  categories: string[];
  feeds: Feed[];
  popularity?: number;
  mcp?: {
    remoteUrl?: string;
    transport?: string;
    isAuthless?: boolean;
    toolNames?: string[];
    authTypes?: string[];
    worksWith?: string[];
    install?: string;
  };
  openapi?: {
    provider: string;
    service?: string;
    version: string;
    /** Machine-readable OpenAPI spec URL. */
    specUrl?: string;
    /** Delegated OAuth scopes the surface needs, so an add flow can request
     *  consent without a vendor-specific table. */
    scopes?: string[];
    /** Human-facing docs or developer portal URL. */
    docsUrl?: string;
    openapiVer: string;
    updated?: string;
    added?: string;
  };
  graphql?: {
    endpoint: string;
    hasSecurity: boolean;
    docs: { description?: string; url: string }[];
  };
  cli?: {
    /** Install / run command, e.g. "brew install gh && gh auth login". */
    install: string;
    /** The registrable domain this CLI is grouped under. */
    domain: string;
    docs?: string;
    repo?: string;
  };
  raw: Partial<Record<Feed, unknown>>;
  tools?: ExtractedTool[];
  toolsStatus?: "ok" | "error" | "skipped";
  toolsReason?: string;
}

export interface ExtractedTool {
  id: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}
