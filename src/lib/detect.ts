/**
 * Domain detection engine — the heart of integrations.sh discovery.
 *
 * Given a domain, runs the full battery of agent-readiness checks in parallel:
 * well-known manifests (api-catalog, mcp-server-card, agent-card, agent-skills,
 * oauth-protected-resource, llms.txt) plus live capability detections
 * (MCP self-onboarding DCR/CIMD, live OpenAPI schema). Every check is
 * schema-validated — never trusts a bare 200 (SPAs/login pages and JSON 404s
 * like `{"error":"Not Found"}` are common false positives).
 *
 * Pure and fetch-injected so it runs identically in the Worker (the detection
 * endpoint), Bun (normalize batch ingestion), and tests.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpDetection {
  url: string;
  source: "api-catalog" | "server-card";
  /** "oauth2" | "none" | undefined (unknown) */
  auth?: string;
  authorizationServer?: string;
  /** Dynamic Client Registration (RFC 7591) — agent can self-register. */
  dcr?: boolean;
  /** Client ID Metadata Document — agent uses a URL as client_id, no registration. */
  cimd?: boolean;
}

export interface DetectionResult {
  domain: string;
  /** Signals that were actually found, for a quick readiness summary. */
  found: string[];
  apiCatalog?: {
    rest: string[];
    openapi: string[];
    docs: string[];
    status: string[];
    mcp: string[];
  };
  apiSchema?: { url: string; format: "openapi"; version?: string };
  mcp: McpDetection[];
  agentCard?: { name?: string; url?: string };
  agentSkills?: { count: number; names: string[] };
  llmsTxt: boolean;
  errors: string[];
}

const TIMEOUT_MS = 7000;

async function get(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<{ res: Response; text: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { "user-agent": "integrations.sh-detector/0.1 (+https://integrations.sh)", ...(init?.headers as Record<string, string> | undefined) };
    const res = await fetchImpl(url, { redirect: "follow", ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    return { res, text };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Parse JSON only when it actually looks like JSON (guards SPA/HTML fallbacks). */
function asJson(text: string, contentType: string | null): any | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  if (contentType && /text\/html/i.test(contentType)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── individual checks ────────────────────────────────────────────────────────

async function checkApiCatalog(fetchImpl: FetchLike, domain: string) {
  const hit = await get(fetchImpl, `https://${domain}/.well-known/api-catalog`);
  if (!hit) return undefined;
  const doc = asJson(hit.text, hit.res.headers.get("content-type"));
  if (!doc || !Array.isArray(doc.linkset)) return undefined;
  const out = { rest: [] as string[], openapi: [] as string[], docs: [] as string[], status: [] as string[], mcp: [] as string[] };
  for (const link of doc.linkset) {
    if (link.anchor) out.rest.push(link.anchor);
    for (const d of link["service-desc"] ?? []) if (d.href) out.openapi.push(d.href);
    for (const d of link["service-doc"] ?? []) if (d.href) out.docs.push(d.href);
    for (const s of link.status ?? []) if (s.href) out.status.push(s.href);
    // Plain items: classify MCP endpoints (sentry lists mcp.sentry.dev/mcp here).
    for (const it of link.item ?? []) {
      if (it.href && /\/mcp\b|mcp\./i.test(it.href)) out.mcp.push(it.href);
      else if (it.href) out.rest.push(it.href);
    }
  }
  return out;
}

async function checkServerCard(fetchImpl: FetchLike, domain: string): Promise<McpDetection | undefined> {
  const hit = await get(fetchImpl, `https://${domain}/.well-known/mcp/server-card.json`);
  if (!hit) return undefined;
  const doc = asJson(hit.text, hit.res.headers.get("content-type"));
  if (!doc || !doc.url) return undefined;
  return { url: doc.url, source: "server-card", auth: doc.authentication?.type, authorizationServer: doc.authentication?.authorization_server };
}

async function checkAgentCard(fetchImpl: FetchLike, domain: string) {
  const hit = await get(fetchImpl, `https://${domain}/.well-known/agent-card.json`);
  if (!hit) return undefined;
  const doc = asJson(hit.text, hit.res.headers.get("content-type"));
  if (!doc || !doc.name) return undefined;
  return { name: doc.name as string, url: doc.url as string | undefined };
}

async function checkAgentSkills(fetchImpl: FetchLike, domain: string) {
  const hit = await get(fetchImpl, `https://${domain}/.well-known/agent-skills/index.json`);
  if (!hit) return undefined;
  const doc = asJson(hit.text, hit.res.headers.get("content-type"));
  if (!doc || !Array.isArray(doc.skills) || doc.skills.length === 0) return undefined; // empty index = no signal
  return { count: doc.skills.length, names: doc.skills.map((s: any) => s.name).filter(Boolean).slice(0, 50) };
}

async function checkLlmsTxt(fetchImpl: FetchLike, domain: string): Promise<boolean> {
  const hit = await get(fetchImpl, `https://${domain}/llms.txt`);
  if (!hit || !hit.res.ok) return false;
  return hit.text.length > 0 && !/<!doctype|<html/i.test(hit.text.slice(0, 200));
}

/** Probe conventional live-spec paths; trust the OpenAPI content-type / key. */
async function checkApiSchema(fetchImpl: FetchLike, domain: string) {
  const paths = ["/api/schema/", "/openapi.json", "/swagger.json", "/api/openapi.json", "/v1/openapi.json"];
  for (const p of paths) {
    const hit = await get(fetchImpl, `https://${domain}${p}`);
    if (!hit || !hit.res.ok) continue;
    const ct = hit.res.headers.get("content-type") ?? "";
    if (/openapi/i.test(ct)) {
      return { url: `https://${domain}${p}`, format: "openapi" as const };
    }
    const doc = asJson(hit.text, ct);
    if (doc && (doc.openapi || doc.swagger)) {
      return { url: `https://${domain}${p}`, format: "openapi" as const, version: doc.openapi ?? doc.swagger };
    }
  }
  return undefined;
}

/**
 * MCP self-onboarding: initialize → WWW-Authenticate → PRM → AS metadata →
 * registration_endpoint (DCR) + client_id_metadata_document_supported (CIMD).
 */
async function detectMcpOnboarding(fetchImpl: FetchLike, mcpUrl: string): Promise<Partial<McpDetection>> {
  const init = await get(fetchImpl, mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integrations.sh", version: "0" } } }),
  });
  if (!init) return {};
  const wwwAuth = init.res.headers.get("www-authenticate") ?? "";
  if (init.res.status !== 401) return { auth: init.res.ok ? "none" : undefined };
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
  if (!prmUrl) return { auth: "oauth2" };
  const prm = await get(fetchImpl, prmUrl);
  const prmDoc = prm && asJson(prm.text, prm.res.headers.get("content-type"));
  const as = prmDoc?.authorization_servers?.[0];
  if (!as) return { auth: "oauth2" };
  const asMeta = await get(fetchImpl, `${String(as).replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  const asDoc = asMeta && asJson(asMeta.text, asMeta.res.headers.get("content-type"));
  return {
    auth: "oauth2",
    authorizationServer: as,
    dcr: Boolean(asDoc?.registration_endpoint),
    cimd: asDoc?.client_id_metadata_document_supported === true,
  };
}

// ── orchestration ────────────────────────────────────────────────────────────

export async function detect(domain: string, fetchImpl: FetchLike = fetch): Promise<DetectionResult> {
  const errors: string[] = [];
  const [apiCatalog, serverCard, agentCard, agentSkills, llmsTxt, apiSchema] = await Promise.all([
    checkApiCatalog(fetchImpl, domain).catch((e) => (errors.push(`api-catalog: ${e}`), undefined)),
    checkServerCard(fetchImpl, domain).catch((e) => (errors.push(`server-card: ${e}`), undefined)),
    checkAgentCard(fetchImpl, domain).catch((e) => (errors.push(`agent-card: ${e}`), undefined)),
    checkAgentSkills(fetchImpl, domain).catch((e) => (errors.push(`agent-skills: ${e}`), undefined)),
    checkLlmsTxt(fetchImpl, domain).catch(() => false),
    checkApiSchema(fetchImpl, domain).catch(() => undefined),
  ]);

  // Collect MCP endpoints from the server card + api-catalog, then probe each
  // for self-onboarding capability.
  const mcpSeen = new Map<string, McpDetection>();
  if (serverCard) mcpSeen.set(serverCard.url, serverCard);
  for (const url of apiCatalog?.mcp ?? []) if (!mcpSeen.has(url)) mcpSeen.set(url, { url, source: "api-catalog" });
  const mcp = await Promise.all(
    [...mcpSeen.values()].map(async (m) => ({ ...m, ...(await detectMcpOnboarding(fetchImpl, m.url).catch(() => ({}))) })),
  );

  const found: string[] = [];
  if (apiCatalog) found.push("api-catalog");
  if (apiSchema) found.push("openapi-schema");
  if (mcp.length) found.push("mcp");
  if (mcp.some((m) => m.dcr || m.cimd)) found.push("mcp-self-onboard");
  if (agentCard) found.push("agent-card");
  if (agentSkills) found.push("agent-skills");
  if (llmsTxt) found.push("llms.txt");

  return { domain, found, apiCatalog, apiSchema, mcp, agentCard, agentSkills, llmsTxt, errors };
}
