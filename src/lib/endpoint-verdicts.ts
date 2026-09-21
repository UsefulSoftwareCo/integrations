/**
 * Probe verdicts applied to discovery documents.
 *
 * WHY. `authStatus: "none"` on an MCP surface is model-authored: the discovery
 * loop records what the docs said, and nothing confirmed it on the wire. The
 * repo keeps a probe cache (output/mcp-endpoints.json, written by
 * scripts/verify-mcp-endpoints.ts) that says what each endpoint actually did
 * when sent an unauthenticated `initialize`. Until now only the search feeds
 * read it; the domain and surface pages rendered straight from KV.
 *
 * This module is the one place that turns a verdict into a published fact:
 *   - dead (404/410, no such host, refused) → the MCP surface is dropped
 *   - unusable URL ({placeholder}, loopback)  → dropped
 *   - none + auth (the server answered 401/403) → the docs were wrong: `unknown`
 *   - none + live/unknown/unprobed → stays `none` with its `discovered` basis
 *
 * A live verdict does NOT upgrade a claim to `detected`. A clean `initialize`
 * proves a server exists, not that its tools run without credentials: Google's
 * MCP endpoints answer `initialize` and `tools/list` unauthenticated and only
 * reject the tool call (issue #69). Public-ness has no cheap probe, so a
 * docs-sourced `none` keeps its lower-rank `discovered` basis and the page
 * labels it as documented rather than verified.
 *
 * Only `none` claims are touched. `required` and `unknown` carry no public
 * claim to contradict. Only MCP surfaces are touched: the probe covers nothing else.
 */
import verdictsJson from "../../output/mcp-endpoints.json";
import type { AuthStatus } from "./discovery-schema.ts";

export type EndpointStatus = "live" | "auth" | "dead" | "unknown";

export interface EndpointVerdict {
  readonly status: EndpointStatus;
  readonly detail: string;
  readonly checkedAt: string;
}

const verdicts: Record<string, EndpointVerdict> = (verdictsJson as { endpoints: Record<string, EndpointVerdict> }).endpoints;

export function endpointVerdict(url: string | undefined): EndpointVerdict | undefined {
  const key = url?.trim();
  return key ? verdicts[key] : undefined;
}

/** Structurally unpublishable regardless of what a probe says: an unsubstituted
 *  `{placeholder}` copied out of docs, or a loopback address that could only
 *  ever have meant the author's own machine. */
export function isUnusableEndpoint(url: string): boolean {
  if (/[{}]/.test(url)) return true;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL parsing reports failure by throwing
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return true;
  }
}

/** Whether an MCP endpoint URL may be published at all. Only a positive denial
 *  removes a record: a timeout or a 5xx means the service had a bad minute. */
export function isPublishableMcpUrl(url: string | undefined): boolean {
  const key = url?.trim();
  if (!key) return true;
  if (isUnusableEndpoint(key)) return false;
  return verdicts[key]?.status !== "dead";
}

/** The auth status a `none` MCP claim is allowed to publish, given the probe:
 *  a server that demanded credentials contradicts the docs, so the claim
 *  becomes `unknown`. Anything else leaves the claim and its basis alone. */
export function verifiedMcpAuth(url: string | undefined, auth: AuthStatus): AuthStatus {
  // Old KV rows predate the strict envelope and can arrive without an auth
  // claim at all. There is then nothing to correct — and a throw here would
  // blank the whole document for the page reading it.
  if (auth?.status !== "none") return auth;
  if (auth.basis.via === "detected") return auth;
  return endpointVerdict(url)?.status === "auth" ? { status: "unknown" } : auth;
}

/** Structural, not `Pick<Surface, …>`: the render paths carry the widened view
 *  type (surface-view.ts — `type: string`, per-kind fields optional), and both
 *  it and the strict wire union must be correctable in place. */
type SurfaceLike = { readonly type?: string; readonly url?: string; readonly auth: AuthStatus };

/** Apply the probe verdicts to a surface list: drop dead MCP endpoints and
 *  downgrade unverified public claims. Non-MCP surfaces pass through untouched. */
export function applyEndpointVerdicts<S extends SurfaceLike>(surfaces: readonly S[]): S[] {
  const out: S[] = [];
  for (const s of surfaces) {
    if (s.type !== "mcp") {
      out.push(s);
      continue;
    }
    if (!isPublishableMcpUrl(s.url)) continue;
    const auth = verifiedMcpAuth(s.url, s.auth);
    out.push(auth === s.auth ? s : { ...s, auth });
  }
  return out;
}
