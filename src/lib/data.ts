import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Integration, Kind } from "./types.ts";

// Only ever read at build time (every consumer prerenders), so resolve from
// the project root: under the adapter the prerender runs out of the bundled
// server chunks in dist/, where module-relative paths point at the wrong tree.
const load = <T>(name: string, fallback: T): T => {
  const p = join(process.cwd(), "output", name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
};

export const mcp: Integration[] = load("mcp.json", []);
export const openapi: Integration[] = load("openapi.json", []);
export const graphql: Integration[] = load("graphql.json", []);
export const cli: Integration[] = load("cli.json", []);

export const all: Integration[] = [...mcp, ...openapi, ...graphql, ...cli];

export const byKind: Record<Kind, Integration[]> = { mcp, openapi, graphql, cli };

/**
 * Enriched index records (`output/index.json`): the slim, display-ready shape
 * the homepage and `/api.json` use. Unlike the per-kind records above, these
 * carry `domain` (the registrable grouping key) and remapped names/icons — but
 * drop the heavy per-format sub-objects. Join back to `byId` for tool counts.
 */
export interface IndexRecord {
  id: string;
  kind: Kind;
  slug: string;
  name: string;
  description: string;
  url?: string;
  icon?: string;
  domain: string;
  categories: string[];
  feeds: string[];
  popularity?: number;
  /** Curated developer-tool domain (scripts/batch/seed-domains*.txt). */
  devtool?: boolean;
}

export const index: IndexRecord[] = load("index.json", []);

/** Full record by id — for detail (tool counts, endpoints) the index omits. */
export const byId: Map<string, Integration> = new Map(all.map((r) => [r.id, r]));

/** Registrable domain by record id — the per-kind records don't carry it. */
export const domainById: Map<string, string> = new Map(
  index.map((r) => [r.id, r.domain || r.slug]),
);

export const kindLabel: Record<Kind, string> = {
  mcp: "MCP server",
  openapi: "OpenAPI",
  graphql: "GraphQL",
  cli: "CLI",
};
