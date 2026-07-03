/**
 * Shared vocabulary for rendering a discovered surface — used by the Surfaces
 * island (domain page) and the SSR'd surface detail page, so a surface reads
 * identically wherever it appears.
 *
 * Types come from the canonical schema via `import type` (zero runtime effect
 * in the client bundle); this module adds only display logic.
 */
import type { AuthStatus, Basis, Credential, DiscoveryResult, Mechanics } from "./discovery-schema.ts";

export type { Credential, Mechanics };
export type { AuthEntry, AuthStatus, Basis, CredentialUse } from "./discovery-schema.ts";

/**
 * Flat renderer view of a Surface: the union widened so per-kind fields are
 * all optional. Display code reads parsed JSON generically ("show url if
 * present"); forcing a type-narrow at every field read buys nothing there.
 * The STRICT discriminated union (discovery-schema.ts Surface) remains the
 * wire/write contract.
 */
export interface Surface {
  slug: string;
  name: string;
  type: string;
  docs?: string;
  basis: Basis;
  auth: AuthStatus;
  spec?: string;
  specAlternates?: readonly string[];
  url?: string;
  transports?: readonly string[];
  packages?: readonly { registryType: string; identifier: string; runtimeHint?: string }[];
  command?: string;
  notes?: string;
}

/** The stored-discovery result shape read back from KV / the baseline JSON. */
export type DiscoveryDoc = Partial<Pick<DiscoveryResult, "credentials">> & { surfaces?: Surface[] };

export const SURFACE_TYPE_LABEL: Record<string, string> = {
  http: "REST",
  graphql: "GraphQL",
  mcp: "MCP",
  cli: "CLI",
  // v2 vocabulary — still in old stored rows until re-discovered.
  openapi: "OpenAPI",
  rest: "REST",
};

export function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Action verb for the credential's "go get it" button, by credential type. */
export function credCta(type: string): string {
  if (type.startsWith("oauth")) return "Set up OAuth";
  if (type === "basic") return "Get credentials";
  if (type === "bearer") return "Get token";
  if (type === "aws_sigv4") return "Get keys";
  return "Get key";
}

/** The CLI login command that acquires a credential, when ANY of its bindings
 * across the given auths is such a flow. `mint login` / `vercel login` runs the
 * OAuth dance — it IS the acquisition and the PRIMARY path — so the "go mint
 * one" CTA (often a raw authorize endpoint or dashboard token page) is wrong,
 * even when the same credential can ALSO be passed via env var or a
 * `--token <x>` flag for CI. Those consumption bindings (`resend --api-key
 * <key>`, env vars) are the non-interactive fallback, not the acquisition, so
 * they no longer suppress the login treatment — login wins if it exists. */
export function cliLoginFor(credId: string, auths: AuthStatus[]): string | undefined {
  const uses = auths
    .flatMap((a) => (a.status === "required" ? a.entries : []))
    .flatMap((e) => e.use)
    .filter((u) => u.id === credId);
  for (const u of uses) {
    const m = u.mechanics;
    if (m.source !== "cli" || !m.command) continue;
    // A placeholder (`<key>`) or env injection means the credential already
    // exists before the command runs — consumption, not acquisition.
    if (/[<{$]/.test(m.command) || m.env?.length) continue;
    return m.command;
  }
  return undefined;
}

/** One-line "how the credential is passed" summary for an auth entry. */
export function mechanicsLine(m: Mechanics): string {
  switch (m.source) {
    case "spec":
      return `OpenAPI scheme · ${m.scheme || "see spec"}`;
    case "well-known":
      return "OAuth · resolves from well-known metadata";
    case "metadata":
      return `OAuth · metadata at ${hostOf(m.url)}`;
    case "cli":
      if (m.command) return `$ ${m.command}`;
      if (m.env?.length) return `env ${m.env.join(", ")}`;
      return "CLI login";
    case "http":
      if (m.in === "query") return `?${m.paramName ?? "api_key"}=<credential>`;
      if (m.in === "body") return `${m.paramName ?? "api_key"}=<credential>`;
      return `${m.headerName ?? "Authorization"}: ${m.scheme ? `${m.scheme} ` : ""}<credential>`;
    default:
      return "mechanics not captured";
  }
}

/** A mechanics line earns its pixels only when it says something the
 * credential label doesn't. Spec-sourced bindings ("OpenAPI scheme · X")
 * restate the scheme name, and an unrecognized source says nothing. */
export function mechanicsSubline(m: Mechanics): string | undefined {
  switch (m.source) {
    case "well-known":
    case "metadata":
    case "cli":
    case "http":
      return mechanicsLine(m);
    default:
      return undefined;
  }
}
