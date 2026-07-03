import { KIND_ORDER, SECTION_LABEL } from "./domain-labels.ts";
import type { DiscoveryResult } from "./discovery-schema.ts";
import { isSdkNotCli } from "./surface-classify.ts";
import type { DiscoveryDoc, Surface } from "./surface-view.ts";

export type DiscoverData = Partial<Pick<DiscoveryResult, "summary" | "description" | "discoveredAt">> & DiscoveryDoc & { detect?: unknown };

export const DISCOVERY_STALE_MS = 12 * 60 * 60 * 1000;

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

export interface DiscoveryFreshness {
  label: string;
  title?: string;
  known: boolean;
  stale: boolean;
  shouldRegenerate: boolean;
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
      // A client SDK/library mis-typed as `cli` is not a CLI surface — drop it.
      .map((surface, idx) => ({ surface, idx, kind: isSdkNotCli(surface) ? null : kindOf(surface.type) }))
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

function compactAge(ageMs: number): string {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;

  if (ageMs < minute) return "just now";
  if (ageMs < hour) return `${Math.max(1, Math.floor(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.floor(ageMs / hour))}h ago`;
  if (ageMs < month) return `${Math.max(1, Math.floor(ageMs / day))}d ago`;
  if (ageMs < year) return `${Math.max(1, Math.floor(ageMs / month))}mo ago`;
  return `${Math.max(1, Math.floor(ageMs / year))}y ago`;
}

export function discoveryFreshness(discoveredAt: string | undefined, hasSurfaces: boolean, nowMs = Date.now()): DiscoveryFreshness {
  const parsed = discoveredAt ? Date.parse(discoveredAt) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return {
      label: "unknown age",
      known: false,
      stale: true,
      shouldRegenerate: hasSurfaces,
    };
  }

  const rawAgeMs = nowMs - parsed;
  const stale = rawAgeMs > DISCOVERY_STALE_MS;
  return {
    label: compactAge(Math.max(0, rawAgeMs)),
    title: new Date(parsed).toISOString(),
    known: true,
    stale,
    shouldRegenerate: hasSurfaces && stale,
  };
}
