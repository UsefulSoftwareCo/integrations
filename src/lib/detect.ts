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
  source: "api-catalog" | "server-card" | "probe";
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
  /** How to authenticate — the bet. Detected from the site's OAuth well-known. */
  auth?: {
    oauth?: {
      authorizationServers?: string[];
      scopes?: string[];
      registrationEndpoint?: string;
      dcr?: boolean;
      cimd?: boolean;
      grantTypes?: string[];
    };
    mcp?: ReadonlyArray<{ url: string; type?: string; authorizationServer?: string; dcr?: boolean; cimd?: boolean }>;
  };
  mcp: McpDetection[];
  agentCard?: { name?: string; url?: string };
  agentSkills?: { count: number; names: string[] };
  llmsTxt: boolean;
  errors: string[];
}

const TIMEOUT_MS = 5000;

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

/**
 * Detect that an OpenAPI spec is *published* (a site signal). We deliberately
 * do NOT parse the spec's contents — auth and the rest come from the site's
 * well-known endpoints, not from mining specs.
 */
async function checkApiSchema(fetchImpl: FetchLike, domain: string) {
  const paths = ["/api/schema/", "/openapi.json", "/swagger.json", "/api/openapi.json", "/v1/openapi.json"];
  // Probe all candidate paths concurrently; keep the first (by order) that is a spec.
  const results = await Promise.all(paths.map(async (p) => {
    const hit = await get(fetchImpl, `https://${domain}${p}`);
    if (!hit || !hit.res.ok) return undefined;
    const ct = hit.res.headers.get("content-type") ?? "";
    const doc = asJson(hit.text, ct);
    const isOpenapi = /openapi/i.test(ct) || Boolean(doc && (doc.openapi || doc.swagger));
    return isOpenapi ? { url: `https://${domain}${p}`, format: "openapi" as const, version: doc?.openapi ?? doc?.swagger } : undefined;
  }));
  return results.find(Boolean);
}

/** Read an OAuth Authorization Server metadata doc (RFC 8414) for capabilities. */
async function asMetadata(fetchImpl: FetchLike, asUrl: string) {
  const base = asUrl.replace(/\/$/, "");
  const hit =
    (await get(fetchImpl, `${base}/.well-known/oauth-authorization-server`)) ??
    (await get(fetchImpl, `${base}/.well-known/openid-configuration`));
  const doc = hit && hit.res.ok ? asJson(hit.text, hit.res.headers.get("content-type")) : undefined;
  if (!doc) return undefined;
  return {
    registrationEndpoint: doc.registration_endpoint as string | undefined,
    dcr: Boolean(doc.registration_endpoint), // Dynamic Client Registration (RFC 7591)
    cimd: doc.client_id_metadata_document_supported === true, // Client ID Metadata Document
    grantTypes: doc.grant_types_supported as string[] | undefined,
    scopes: doc.scopes_supported as string[] | undefined,
  };
}

/**
 * The site's API OAuth — from well-known only: protected-resource (RFC 9728)
 * for the resource→auth-server map + scopes, then the authorization-server
 * metadata for DCR / CIMD / grant types.
 */
async function checkApiOAuth(fetchImpl: FetchLike, domain: string) {
  const prm = await get(fetchImpl, `https://${domain}/.well-known/oauth-protected-resource`);
  const prmDoc = prm && prm.res.ok ? asJson(prm.text, prm.res.headers.get("content-type")) : undefined;
  const servers: string[] | undefined = Array.isArray(prmDoc?.authorization_servers) && prmDoc.authorization_servers.length
    ? prmDoc.authorization_servers
    : undefined;
  const asUrl = servers?.[0] ?? `https://${domain}`; // fall back to the domain's own AS metadata
  const meta = await asMetadata(fetchImpl, asUrl);
  if (!servers && !meta) return undefined;
  return {
    authorizationServers: servers ?? [asUrl],
    scopes: (prmDoc?.scopes_supported as string[] | undefined) ?? meta?.scopes,
    registrationEndpoint: meta?.registrationEndpoint,
    dcr: meta?.dcr,
    cimd: meta?.cimd,
    grantTypes: meta?.grantTypes,
  };
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

/** Probe the conventional /mcp path; confirm it's actually an MCP endpoint. */
async function discoverMcpEndpoint(fetchImpl: FetchLike, domain: string): Promise<string | undefined> {
  const url = `https://${domain}/mcp`;
  const hit = await get(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integrations.sh", version: "0" } } }),
  });
  if (!hit) return undefined;
  const wwwAuth = hit.res.headers.get("www-authenticate") ?? "";
  const looksMcp = (hit.res.status === 401 && /resource_metadata=/.test(wwwAuth)) || (hit.res.ok && /["']?jsonrpc/.test(hit.text));
  return looksMcp ? url : undefined;
}

// ── orchestration ────────────────────────────────────────────────────────────

export async function detect(domain: string, fetchImpl: FetchLike = fetch): Promise<DetectionResult> {
  const errors: string[] = [];
  const discoverMcpEndpointResult = discoverMcpEndpoint(fetchImpl, domain); // start concurrently
  const [apiCatalog, serverCard, agentCard, agentSkills, llmsTxt, apiSchema, apiOAuth] = await Promise.all([
    checkApiCatalog(fetchImpl, domain).catch((e) => (errors.push(`api-catalog: ${e}`), undefined)),
    checkServerCard(fetchImpl, domain).catch((e) => (errors.push(`server-card: ${e}`), undefined)),
    checkAgentCard(fetchImpl, domain).catch((e) => (errors.push(`agent-card: ${e}`), undefined)),
    checkAgentSkills(fetchImpl, domain).catch((e) => (errors.push(`agent-skills: ${e}`), undefined)),
    checkLlmsTxt(fetchImpl, domain).catch(() => false),
    checkApiSchema(fetchImpl, domain).catch(() => undefined),
    checkApiOAuth(fetchImpl, domain).catch(() => undefined),
  ]);
  const probedMcp = await discoverMcpEndpointResult.catch(() => undefined);

  // Collect MCP endpoints from the server card + api-catalog, then probe each
  // for self-onboarding capability.
  const mcpSeen = new Map<string, McpDetection>();
  if (serverCard) mcpSeen.set(serverCard.url, serverCard);
  for (const url of apiCatalog?.mcp ?? []) if (!mcpSeen.has(url)) mcpSeen.set(url, { url, source: "api-catalog" });
  if (probedMcp && !mcpSeen.has(probedMcp)) mcpSeen.set(probedMcp, { url: probedMcp, source: "probe" });
  const mcp = await Promise.all(
    [...mcpSeen.values()].map(async (m) => ({ ...m, ...(await detectMcpOnboarding(fetchImpl, m.url).catch(() => ({}))) })),
  );

  // Aggregate auth — the bet — from the site's OAuth well-known: the API's
  // authorization server (DCR/CIMD/scopes) and each MCP endpoint's auth.
  const mcpAuth = mcp
    .filter((m) => m.auth && m.auth !== "none")
    .map((m) => ({ url: m.url, type: m.auth, authorizationServer: m.authorizationServer, dcr: m.dcr, cimd: m.cimd }));
  const auth = {
    ...(apiOAuth ? { oauth: apiOAuth } : {}),
    ...(mcpAuth.length ? { mcp: mcpAuth } : {}),
  };
  const hasAuth = Object.keys(auth).length > 0;

  const found: string[] = [];
  if (apiCatalog) found.push("api-catalog");
  if (apiSchema) found.push("openapi-schema");
  if (mcp.length) found.push("mcp");
  if (mcp.some((m) => m.dcr || m.cimd)) found.push("mcp-self-onboard");
  if (agentCard) found.push("agent-card");
  if (agentSkills) found.push("agent-skills");
  if (llmsTxt) found.push("llms.txt");
  if (hasAuth) found.push("auth");

  return { domain, found, apiCatalog, apiSchema, auth: hasAuth ? auth : undefined, mcp, agentCard, agentSkills, llmsTxt, errors };
}
