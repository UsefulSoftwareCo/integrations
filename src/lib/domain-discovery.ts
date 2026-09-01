import type { CatalogDomain } from "./discovered-catalog.ts";
import { catalogDiscovery, recordToSurface } from "./catalog-to-discovery.ts";
import type { CuratedProvider } from "./curated.ts";
import type { DiscoverData } from "./surface-sections.ts";
import type { Surface } from "./surface-view.ts";
import type { Integration } from "./types.ts";

const DISCOVERED_BASIS = { via: "discovered" as const, evidence: [] as string[] };
const REGISTRY_BASIS = { via: "detected" as const, signal: "registry" };

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "surface"
  );
}

function assignSlug(name: string, existing: { slug: string }[]): string {
  const base = slugify(name);
  const taken = new Set(existing.map((item) => item.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function authStatusToSurface(status: "none" | "required" | "unknown") {
  return status === "none"
    ? { status: "none" as const, basis: DISCOVERED_BASIS }
    : status === "required"
      ? { status: "required" as const, entries: [] }
      : { status: "unknown" as const };
}

function discoveredSurfaceToSurface(surface: CatalogDomain["surfaces"][number]): Surface {
  if (surface.type === "cli") {
    return {
      slug: surface.slug,
      name: surface.name,
      type: "cli",
      command: surface.command,
      packages: surface.packages,
      basis: DISCOVERED_BASIS,
      auth: authStatusToSurface(surface.authStatus),
    };
  }
  if (surface.type === "mcp") {
    return {
      slug: surface.slug,
      name: surface.name,
      type: "mcp",
      url: surface.url,
      basis: DISCOVERED_BASIS,
      auth: authStatusToSurface(surface.authStatus),
    };
  }
  if (surface.type === "graphql") {
    return {
      slug: surface.slug,
      name: surface.name,
      type: "graphql",
      url: surface.url ?? "",
      basis: DISCOVERED_BASIS,
      auth: authStatusToSurface(surface.authStatus),
    };
  }
  return {
    slug: surface.slug,
    name: surface.name,
    type: "http",
    spec: surface.spec,
    url: surface.url,
    basis: DISCOVERED_BASIS,
    auth: authStatusToSurface(surface.authStatus),
  };
}

function curatedInterfaceToSurface(provider: CuratedProvider, iface: CuratedProvider["interfaces"][number], slugs: { slug: string }[]): Surface {
  const slug = assignSlug(iface.name || `${provider.name} ${iface.format}`, slugs);
  slugs.push({ slug });
  const auth = iface.auth === "none" ? { status: "none" as const } : { status: "unknown" as const };
  if (iface.format === "cli") {
    return {
      slug,
      name: iface.name,
      type: "cli",
      command: iface.install?.split(/\s+/).find(Boolean),
      docs: iface.docs,
      notes: iface.install ?? iface.note,
      basis: REGISTRY_BASIS,
      auth,
    };
  }
  if (iface.format === "mcp") {
    return {
      slug,
      name: iface.name,
      type: "mcp",
      url: iface.endpoint,
      docs: iface.docs,
      basis: REGISTRY_BASIS,
      auth,
    };
  }
  if (iface.format === "graphql") {
    return {
      slug,
      name: iface.name,
      type: "graphql",
      url: iface.endpoint ?? "",
      docs: iface.docs,
      basis: REGISTRY_BASIS,
      auth,
    };
  }
  return {
    slug,
    name: iface.name,
    type: "http",
    url: iface.endpoint,
    spec: iface.specUrl,
    docs: iface.docs,
    basis: REGISTRY_BASIS,
    auth,
  };
}

function surfaceKey(surface: Pick<Surface, "type" | "name"> & Partial<Surface>): string {
  if (surface.type === "cli") return `cli:${surface.command ?? surface.name.toLowerCase()}`;
  if (surface.type === "mcp") return `mcp:${surface.url ?? surface.name.toLowerCase()}`;
  if (surface.type === "graphql") return `graphql:${surface.url ?? surface.name.toLowerCase()}`;
  return `http:${surface.spec ?? surface.url ?? surface.name.toLowerCase()}`;
}

export function buildDomainDiscovery(
  domain: string,
  records: Integration[],
  discovered: CatalogDomain | null = null,
  curated: CuratedProvider | null = null,
): DiscoverData {
  const baseline: DiscoverData = catalogDiscovery(domain, records);
  const surfaces: Surface[] = [];
  const seen = new Set<string>();

  const push = (surface: Surface) => {
    const key = surfaceKey(surface);
    if (seen.has(key)) return;
    seen.add(key);
    surfaces.push(surface);
  };

  for (const surface of discovered?.surfaces ?? []) push(discoveredSurfaceToSurface(surface));

  const curatedSlugs = surfaces.map((surface) => ({ slug: surface.slug }));
  for (const iface of curated?.interfaces ?? []) push(curatedInterfaceToSurface(curated, iface, curatedSlugs));

  for (const record of records) {
    const surface = recordToSurface(record);
    if (!surface) continue;
    push({ ...surface, slug: baseline.surfaces.find((item) => item.name === surface.name && item.type === surface.type)?.slug ?? assignSlug(surface.name, surfaces) });
  }

  return {
    ...baseline,
    description: discovered?.description ?? curated?.description,
    summary: discovered?.summary ?? baseline.summary,
    discoveredAt: discovered?.discoveredAt,
    surfaces,
  };
}
