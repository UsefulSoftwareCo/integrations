import { KIND_ORDER, SECTION_LABEL } from "./domain-labels.ts";
import type { DiscoveryResult } from "./discovery-schema.ts";
import type { DiscoveryDoc, Surface } from "./surface-view.ts";

export type DiscoverData = Partial<Pick<DiscoveryResult, "summary">> & DiscoveryDoc;

type SectionKind = (typeof KIND_ORDER)[number];

export interface SurfaceEntry {
  key: string;
  name: string;
  href?: string;
  meta?: string;
  surface: Surface;
}

export interface SurfaceSection {
  kind: SectionKind;
  label: string;
  entries: SurfaceEntry[];
}

/** surface.type -> page section kind. v3 `http` and legacy openapi/rest share
 * the OpenAPI section. */
export function kindOf(t: string): SectionKind | null {
  if (t === "http" || t === "rest" || t === "openapi") return "openapi";
  if (t === "mcp" || t === "graphql" || t === "cli") return t;
  return null;
}

function surfaceMeta(s: Surface): string {
  switch (s.type) {
    case "mcp":
      return s.transports?.[0] ?? "mcp";
    case "graphql":
      return "graphql";
    case "cli":
      return s.command ?? "cli";
    default:
      return "rest";
  }
}

/** Build the domain-page sections from discovery data only. Static catalog rows
 * are intentionally not accepted here, so they cannot merge or duplicate with
 * KV, baseline, or live discovery results. */
export function buildSections(data: DiscoverData | null, domain: string): SurfaceSection[] {
  const surfaces = data?.surfaces ?? [];
  const discPage = (s: Surface) => (s.slug ? `/${encodeURIComponent(domain)}/${encodeURIComponent(s.slug)}/` : undefined);
  const out: SurfaceSection[] = [];

  for (const kind of KIND_ORDER) {
    const entries = surfaces
      .map((surface, idx) => ({ surface, idx, kind: kindOf(surface.type) }))
      .filter((item) => item.kind === kind)
      .map(({ surface, idx }) => ({
        key: `${surface.slug || surface.name}-${idx}`,
        name: surface.name,
        href: discPage(surface),
        meta: surfaceMeta(surface),
        surface,
      }));

    if (entries.length) out.push({ kind, label: SECTION_LABEL[kind], entries });
  }

  return out;
}
