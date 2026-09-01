import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalDomain } from "./domain-aliases.ts";

export interface CatalogPackage {
  registryType: string;
  identifier: string;
  runtimeHint?: string;
}

export interface CatalogSurface {
  slug: string;
  name: string;
  type: "http" | "graphql" | "mcp" | "cli";
  url?: string;
  spec?: string;
  command?: string;
  packages?: CatalogPackage[];
  authStatus: "none" | "required" | "unknown";
}

export interface CatalogDomain {
  domain: string;
  description?: string;
  summary: string;
  discoveredAt?: string;
  surfaces: CatalogSurface[];
}

export interface Catalog {
  domains: CatalogDomain[];
}

const DOMAINS_DIR = join(process.cwd(), "domains");

function domainFilePath(root: string, domain: string): string {
  return join(root, domain, "integrations.json");
}

export function readDomainCatalogTree(root = DOMAINS_DIR): Catalog {
  if (!existsSync(root)) return { domains: [] };

  const domains = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => domainFilePath(root, entry.name))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as CatalogDomain)
    .sort((a, b) => canonicalDomain(a.domain).localeCompare(canonicalDomain(b.domain)) || a.domain.localeCompare(b.domain));

  return { domains };
}
