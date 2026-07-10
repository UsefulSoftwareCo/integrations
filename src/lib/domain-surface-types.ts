import { KIND_ORDER } from "./domain-labels.ts";
import type { Kind } from "./types.ts";

type SurfaceType = Kind | "http" | "rest" | "openapi" | "mcp" | "graphql" | "cli" | null | undefined;

export interface DomainSurfaceTypeSources {
  curated?: Iterable<SurfaceType>;
  discovered?: Iterable<SurfaceType>;
  catalog?: Iterable<SurfaceType>;
}

export interface DomainSurfaceCounts extends Partial<Record<Kind, number>> {}

export function normalizeSurfaceType(type: SurfaceType): Kind | null {
  if (type === "http" || type === "rest" || type === "openapi") return "openapi";
  if (type === "mcp" || type === "graphql" || type === "cli") return type;
  return null;
}

export function mergeDomainSurfaceTypes(sources: DomainSurfaceTypeSources): Kind[] {
  const kinds = new Set<Kind>();
  for (const group of [sources.curated, sources.discovered, sources.catalog]) {
    for (const type of group ?? []) {
      const kind = normalizeSurfaceType(type);
      if (kind) kinds.add(kind);
    }
  }
  return KIND_ORDER.filter((kind) => kinds.has(kind));
}

export function mergeDomainSurfaceCounts(
  counts: DomainSurfaceCounts,
  sources: DomainSurfaceTypeSources,
): DomainSurfaceCounts {
  const merged: DomainSurfaceCounts = { ...counts };
  for (const kind of mergeDomainSurfaceTypes(sources)) {
    merged[kind] = Math.max(merged[kind] ?? 0, 1);
  }
  return merged;
}
