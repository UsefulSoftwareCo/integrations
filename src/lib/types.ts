export type Kind = "mcp" | "openapi" | "graphql" | "cli";

/** Display formats. Superset of Kind: curated providers can also expose CLIs. */
export type Format = "mcp" | "openapi" | "graphql" | "cli";

export type Feed = "claude" | "openai" | "apis-guru" | "graphql-apis" | "override" | "cli-seed";

export interface Integration {
  id: string;
  kind: Kind;
  slug: string;
  name: string;
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
  };
  openapi?: {
    provider: string;
    service?: string;
    version: string;
    /** Machine-readable OpenAPI spec URL. */
    specUrl?: string;
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
