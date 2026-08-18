import catalogSeedJson from "../../output/catalog-seeds.json";
import type { Feed, Kind } from "./types.ts";

export interface CatalogSeedEntry {
  kind: Kind;
  name: string;
  feeds: Feed[];
  remoteUrl?: string;
  transport?: string;
  authTypes?: string[];
  specUrl?: string;
  docsUrl?: string;
  endpoint?: string;
  docs?: string;
  command?: string;
  install?: string;
  repo?: string;
}

let catalogSeedData = catalogSeedJson as Record<string, CatalogSeedEntry[]>;

export function setCatalogSeedDataForTest(data: Record<string, CatalogSeedEntry[]> | null): void {
  catalogSeedData = data ?? (catalogSeedJson as Record<string, CatalogSeedEntry[]>);
}

export function catalogSeedRecords(domain: string): CatalogSeedEntry[] {
  const target = domain.trim().toLowerCase();
  if (!target) return [];
  return (catalogSeedData[target] ?? []).filter((record) => !record.feeds.includes("discovered"));
}

export function catalogSeeds(domain: string): string[] {
  const target = domain.trim().toLowerCase();
  if (!target) return [];

  const facts: string[] = [];
  for (const record of catalogSeedRecords(target)) {
    const fact = seedFor(record);
    if (fact) facts.push(fact);
  }
  return facts;
}

function seedFor(record: CatalogSeedEntry): string | null {
  switch (record.kind) {
    case "mcp":
      return mcpSeed(record);
    case "openapi":
      return openapiSeed(record);
    case "graphql":
      return graphqlSeed(record);
    case "cli":
      return cliSeed(record);
    default:
      return null;
  }
}

function mcpSeed(record: CatalogSeedEntry): string | null {
  const remoteUrl = clean(record.remoteUrl);
  if (!remoteUrl) return null;

  return withDetails(
    `Known MCP server (from the ${feedList(record.feeds)} registries): ${clean(record.name)} at ${remoteUrl}`,
    [
      detail("transport", record.transport),
      detail("authTypes", record.authTypes?.join(", ")),
    ],
  );
}

function openapiSeed(record: CatalogSeedEntry): string | null {
  const specUrl = clean(record.specUrl);
  if (!specUrl) return null;

  return withDetails(
    `Known OpenAPI spec: ${clean(record.name)} — ${specUrl}`,
    [detail("docs", record.docsUrl)],
  );
}

function graphqlSeed(record: CatalogSeedEntry): string | null {
  const endpoint = clean(record.endpoint);
  if (!endpoint) return null;

  return withDetails(
    `Known GraphQL endpoint: ${clean(record.name)} — ${endpoint}`,
    [detail("docs", record.docs)],
  );
}

function cliSeed(record: CatalogSeedEntry): string | null {
  const command = clean(record.command);
  if (!command) return null;

  return withDetails(
    `Known CLI command: ${clean(record.name)} — ${command}`,
    [
      detail("install", record.install),
      detail("docs", record.docs),
      detail("repo", record.repo),
    ],
  );
}

function detail(label: string, value: string | undefined): string | undefined {
  const cleaned = clean(value);
  return cleaned ? `${label}: ${cleaned}` : undefined;
}

function withDetails(base: string, details: Array<string | undefined>): string {
  const present = details.filter((d): d is string => !!d);
  return present.length ? `${base} (${present.join("; ")})` : base;
}

function feedList(feeds: readonly string[]): string {
  return feeds.length ? feeds.join("/") : "catalog";
}

function clean(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}
