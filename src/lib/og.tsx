import React from "react";
import satori, { init as initSatori, type Font } from "satori/wasm";
import { initWasm as initResvgWasm, Resvg, type InitInput as ResvgInitInput } from "@resvg/resvg-wasm";
import { SURFACE_TYPE_LABEL, hostOf, type Credential, type DiscoveryDoc, type Surface } from "./surface-view.ts";
import { TOTAL_SURFACE_COUNT } from "./og-count.ts";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export interface OgFonts {
  geist400: ArrayBuffer;
  geist500: ArrayBuffer;
  geist600: ArrayBuffer;
  mono400: ArrayBuffer;
  mono500: ArrayBuffer;
  mono600: ArrayBuffer;
}

export interface OgImageData {
  dataUri: string;
  contentType: string;
}

export type OgInput =
  | { kind: "home"; total?: number }
  | { kind: "domain"; domain: string; doc: DiscoveryDoc; favicon?: OgImageData | null }
  | { kind: "surface"; domain: string; surface: Surface; credentials?: Record<string, Credential>; favicon?: OgImageData | null };

export type OgWasmInput = Promise<ResvgInitInput> | ResvgInitInput;
export type OgYogaInput = Parameters<typeof initSatori>[0];
export interface OgRuntimeInput {
  yoga: Promise<OgYogaInput> | OgYogaInput;
  resvg: OgWasmInput;
}

const c = {
  bg: "#0a0a0a",
  fg: "#ededed",
  muted: "#9a9a9a",
  hairline: "#1f1f1f",
  chip: "#333",
  tile: "#0f0f0f",
  dim: "#666",
  grid: "#141414",
};

const baseFont = '"Geist", ui-sans-serif, system-ui, sans-serif';
const monoFont = '"Geist Mono", ui-monospace, Menlo, monospace';

let runtimeReady: Promise<void> | null = null;

export function initOgRuntime(runtime: OgRuntimeInput): Promise<void> {
  runtimeReady ??= Promise.all([
    initSatori(runtime.yoga),
    initResvgWasm(runtime.resvg),
  ]).then(() => undefined);
  return runtimeReady;
}

export function ogFontList(fonts: OgFonts): Font[] {
  return [
    { name: "Geist", data: fonts.geist400, weight: 400, style: "normal" },
    { name: "Geist", data: fonts.geist500, weight: 500, style: "normal" },
    { name: "Geist", data: fonts.geist600, weight: 600, style: "normal" },
    { name: "Geist Mono", data: fonts.mono400, weight: 400, style: "normal" },
    { name: "Geist Mono", data: fonts.mono500, weight: 500, style: "normal" },
    { name: "Geist Mono", data: fonts.mono600, weight: 600, style: "normal" },
  ];
}

export async function renderOgPng(input: OgInput, fonts: OgFonts, runtime: OgRuntimeInput): Promise<Uint8Array> {
  await initOgRuntime(runtime);
  const svg = await satori(<OgCard input={input} />, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: ogFontList(fonts),
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_WIDTH },
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

function typeLabel(surface: Surface): string {
  return SURFACE_TYPE_LABEL[surface.type] ?? surface.type.toUpperCase();
}

function authBadge(auth: Surface["auth"]): string {
  if (auth.status === "none") return "no auth";
  if (auth.status === "required") return "auth required";
  return "auth unknown";
}

function credentialLabels(surface: Surface, credentials: Record<string, Credential> = {}): string[] {
  if (surface.auth.status !== "required") return [];
  const ids = surface.auth.entries.flatMap((entry) => entry.use.map((use) => use.id));
  return ids
    .filter((id, i) => ids.indexOf(id) === i)
    .map((id) => credentials[id]?.label ?? id)
    .filter(Boolean);
}

function authDetail(surface: Surface, credentials: Record<string, Credential> = {}): string {
  if (surface.auth.status === "none") return "public";
  if (surface.auth.status === "unknown") return "auth unknown";
  const labels = credentialLabels(surface, credentials);
  return labels[0]?.toLowerCase() ?? surface.auth.entries[0]?.use[0]?.mechanics?.source ?? "auth required";
}

function rowSignature(surface: Surface, credentials: Record<string, Credential> = {}): string {
  const label = typeLabel(surface);
  if (surface.type === "mcp") return [label, hostOf(surface.url) || surface.url].filter(Boolean).join(" · ");
  if (surface.type === "cli") return [label, surface.command].filter(Boolean).join(" · ");
  if (surface.type === "graphql") return [label, hostOf(surface.url) || authDetail(surface, credentials)].filter(Boolean).join(" · ");
  return [label, authDetail(surface, credentials)].filter(Boolean).join(" · ");
}

function endpointValue(surface: Surface): { label: "ENDPOINT" | "SPEC" | "COMMAND" | "URL"; value: string } | null {
  if (surface.type === "cli" && surface.command) return { label: "COMMAND", value: surface.command };
  if (surface.url) {
    const value = hostOf(surface.url) && /^https?:\/\//.test(surface.url) ? surface.url.replace(/^https?:\/\//, "") : surface.url;
    return { label: "ENDPOINT", value };
  }
  if (surface.spec) {
    const value = surface.spec === "introspection" ? "introspection" : surface.spec.replace(/^https?:\/\//, "");
    return { label: "SPEC", value };
  }
  return null;
}

function authValue(surface: Surface, credentials: Record<string, Credential> = {}): string {
  if (surface.auth.status === "none") return "No auth";
  if (surface.auth.status === "unknown") return "Unknown";
  const labels = credentialLabels(surface, credentials);
  if (labels.length <= 3) return labels.join(" · ") || "Auth required";
  return `${labels.slice(0, 3).join(" · ")} +${labels.length - 3}`;
}

function kinds(surfaces: Surface[]): string[] {
  return [...new Set(surfaces.map(typeLabel))];
}

function middleTruncate(value: string, max = 40): string {
  if (value.length <= max) return value;
  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function OgCard({ input }: { input: OgInput }) {
  return (
    <div style={{
      width: OG_WIDTH,
      height: OG_HEIGHT,
      backgroundColor: c.bg,
      color: c.fg,
      position: "relative",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      padding: "72px 84px",
      fontFamily: baseFont,
    }}>
      <Grid />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
        {input.kind === "home" && <Home total={input.total ?? TOTAL_SURFACE_COUNT} />}
        {input.kind === "domain" && <Domain domain={input.domain} doc={input.doc} favicon={input.favicon} />}
        {input.kind === "surface" && <SurfaceCard domain={input.domain} surface={input.surface} credentials={input.credentials ?? {}} favicon={input.favicon} />}
      </div>
    </div>
  );
}

function Grid() {
  const vertical = Array.from({ length: Math.ceil(OG_WIDTH / 84) + 1 }, (_, i) => i * 84);
  const horizontal = Array.from({ length: Math.ceil(OG_HEIGHT / 84) + 1 }, (_, i) => i * 84);
  return (
    <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: 0.55, display: "flex" }}>
      {vertical.map((x) => (
        <div key={`v${x}`} style={{ position: "absolute", left: x, top: 0, width: 1, height: OG_HEIGHT, backgroundColor: c.grid }} />
      ))}
      {horizontal.map((y) => (
        <div key={`h${y}`} style={{ position: "absolute", left: 0, top: y, width: OG_WIDTH, height: 1, backgroundColor: c.grid }} />
      ))}
    </div>
  );
}

function Wordmark() {
  return (
    <span style={{ fontFamily: monoFont, fontSize: 26, color: c.fg, letterSpacing: "-0.01em" }}>
      integrations<span style={{ color: c.muted }}>.sh</span>
    </span>
  );
}

function SecLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: monoFont, fontSize: 20, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: c.muted }}>
      {children}
    </span>
  );
}

function Footer({ label }: { label?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "auto", paddingTop: 40 }}>
      <Wordmark />
      {label && <SecLabel>{label}</SecLabel>}
    </div>
  );
}

function Home({ total }: { total: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <h1 style={{ fontSize: 76, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1.08, maxWidth: 950, margin: 0 }}>
        The registry of everything your agent can reach.
      </h1>
      <p style={{ fontSize: 30, lineHeight: 1.5, margin: "34px 0 0", maxWidth: 860, color: c.fg, fontWeight: 500 }}>
        Open source catalog of every MCP, CLI, API
      </p>
      <p style={{ fontSize: 27, lineHeight: 1.5, margin: "18px 0 0", maxWidth: 860, color: c.muted, fontWeight: 400 }}>
        {total.toLocaleString()} integrations and how to authenticate to them, to embed into your product, give to your agent, or use for yourself
      </p>
      <Footer label="the integration registry" />
    </div>
  );
}

function FaviconTile({ domain, favicon, size = 108 }: { domain: string; favicon?: OgImageData | null; size?: 72 | 108 }) {
  const letter = (domain[0] || "?").toUpperCase();
  const radius = size === 72 ? 16 : 22;
  const imageSize = size === 72 ? 52 : 76;
  return (
    <div style={{
      width: size,
      height: size,
      border: `1.5px solid ${c.hairline}`,
      borderRadius: radius,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.tile,
      flexShrink: 0,
      overflow: "hidden",
    }}>
      {favicon?.dataUri ? (
        <img src={favicon.dataUri} width={imageSize} height={imageSize} style={{ borderRadius: size === 72 ? 10 : 16 }} />
      ) : (
        <span style={{ fontSize: size === 72 ? 34 : 52, fontWeight: 600, color: c.fg }}>{letter}</span>
      )}
    </div>
  );
}

function Domain({ domain, doc, favicon }: { domain: string; doc: DiscoveryDoc; favicon?: OgImageData | null }) {
  const surfaces = doc.surfaces ?? [];
  const visible = surfaces.slice(0, 5);
  const hasOverflow = surfaces.length > 5;
  const meta = `${surfaces.length.toLocaleString()} integrations · ${kinds(surfaces).join(" · ")}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
        <FaviconTile domain={domain} favicon={favicon} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <h1 style={{ fontSize: 72, fontWeight: 600, letterSpacing: "-0.04em", margin: 0 }}>{domain}</h1>
          <div style={{ fontFamily: monoFont, fontSize: 24, color: c.muted, marginTop: 12 }}>{meta}</div>
        </div>
      </div>
      <div style={{
        marginTop: 52,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        ...(hasOverflow ? { maxHeight: 436, overflow: "hidden" as const } : {}),
      }}>
        {visible.map((surface) => (
          <div key={surface.slug} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "26px 4px", borderTop: `1px solid ${c.hairline}`, gap: 24 }}>
            <span style={{ fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 650 }}>
              {surface.name}
            </span>
            <span style={{ fontFamily: monoFont, fontSize: 22, color: c.muted, border: `1.5px solid ${c.chip}`, borderRadius: 8, padding: "6px 16px", whiteSpace: "nowrap" }}>
              {rowSignature(surface, doc.credentials ?? {})}
            </span>
          </div>
        ))}
        {hasOverflow && (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 250, backgroundColor: c.bg, opacity: 0.92 }} />
        )}
      </div>
      <div style={{ position: "relative", marginTop: hasOverflow ? -30 : "auto", paddingTop: 40, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Wordmark />
        <SecLabel>how to integrate</SecLabel>
      </div>
    </div>
  );
}

function Chip({ strong, children }: { strong?: string; children?: React.ReactNode }) {
  return (
    <span style={{ display: "flex", alignItems: "center", fontFamily: monoFont, fontSize: 24, color: c.muted, border: `1.5px solid ${c.chip}`, borderRadius: 10, padding: "10px 22px" }}>
      {strong && <b style={{ color: c.fg, fontWeight: 500, marginRight: children ? 12 : 0 }}>{strong}</b>}
      {children}
    </span>
  );
}

function SurfaceCard({ domain, surface, credentials, favicon }: { domain: string; surface: Surface; credentials: Record<string, Credential>; favicon?: OgImageData | null }) {
  const isLong = surface.name.length > 60;
  const first = endpointValue(surface);
  const auth = authValue(surface, credentials);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <FaviconTile domain={domain} favicon={favicon} size={72} />
        <div style={{ display: "flex", alignItems: "center", fontFamily: monoFont, fontSize: 24, color: c.muted }}>
          registry<span style={{ margin: "0 14px", color: c.chip }}>/</span>{domain}<span style={{ margin: "0 14px", color: c.chip }}>/</span>{middleTruncate(surface.slug)}
        </div>
      </div>
      <h1 style={{
        fontSize: isLong ? 44 : 68,
        fontWeight: 600,
        letterSpacing: "-0.04em",
        lineHeight: isLong ? 1.22 : 1.1,
        margin: "28px 0 0",
        maxWidth: 1000,
        lineClamp: 2,
      }}>
        {surface.name}
      </h1>
      <div style={{ display: "flex", gap: 16, marginTop: 44 }}>
        <Chip strong={typeLabel(surface)} />
        <Chip>{authBadge(surface.auth)}</Chip>
      </div>
      <div style={{ marginTop: 54, display: "flex", flexDirection: "column" }}>
        {first && <KvRow label={first.label} value={first.value} />}
        <KvRow label="AUTH" value={auth} />
      </div>
      <Footer />
    </div>
  );
}

function KvRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", padding: "20px 4px", borderTop: `1px solid ${c.hairline}` }}>
      <dt style={{ fontFamily: monoFont, fontSize: 22, color: c.muted, width: 260, flexShrink: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</dt>
      <dd style={{ fontFamily: monoFont, fontSize: 26, color: c.fg, margin: 0, maxWidth: 720, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</dd>
    </div>
  );
}
