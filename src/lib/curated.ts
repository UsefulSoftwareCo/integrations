import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDomain as tldGetDomain } from "tldts";
import { canonicalDomain } from "./domain-aliases.ts";
import type { Kind } from "./types.ts";

export interface CuratedInterface {
  format: Kind;
  name: string;
  endpoint?: string;
  specUrl?: string;
  auth: "oauth" | "api_key" | "token" | "none" | "mixed";
  authHeader?: string;
  install?: string;
  docs?: string;
  note?: string;
  origin: "vendor" | "community";
  maintainer?: string;
  repo?: string;
}

export interface CuratedProvider {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  domain: string;
  icon?: string;
  categories: string[];
  interfaces: CuratedInterface[];
  links?: { homepage?: string; docs?: string };
}

const CURATED_DIR = join(process.cwd(), "curated");
const getDomain = (value: string) => tldGetDomain(value, { allowPrivateDomains: true });

const providers: CuratedProvider[] = (() => {
  if (!existsSync(CURATED_DIR)) return [];
  return readdirSync(CURATED_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(CURATED_DIR, file), "utf8")) as CuratedProvider);
})();

function targetDomains(provider: CuratedProvider): string[] {
  const targets = new Set<string>();
  targets.add(canonicalDomain(provider.domain));
  const urls = [
    provider.links?.homepage,
    provider.links?.docs,
    ...provider.interfaces.flatMap((iface) => [iface.endpoint, iface.specUrl, iface.docs, iface.repo]),
  ];
  for (const url of urls) {
    if (!url) continue;
    const domain = getDomain(url);
    if (domain) targets.add(canonicalDomain(domain));
  }
  return [...targets];
}

const byDomain = new Map<string, CuratedProvider>();
for (const provider of providers) {
  for (const domain of targetDomains(provider)) {
    if (domain && !byDomain.has(domain)) byDomain.set(domain, provider);
  }
}

export function allCuratedProviders(): CuratedProvider[] {
  return providers;
}

export function curatedProviderForDomain(domain: string): CuratedProvider | null {
  return byDomain.get(canonicalDomain(domain)) ?? null;
}
