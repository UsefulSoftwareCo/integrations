export const INTEGRATIONS_JSON_PATH = "/.well-known/integrations.json";
export const LLMS_TXT_PATH = "/llms.txt";
export const API_CATALOG_PATH = "/.well-known/api-catalog";
export const MCP_SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";
export const OAUTH_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const AGENT_SKILLS_PATH = "/.well-known/agent-skills/index.json";
export const OPENAPI_PROBE_PATHS = ["/api/schema/", "/openapi.json", "/swagger.json", "/api/openapi.json", "/v1/openapi.json"] as const;

export const PROBE_KEYS = {
  integrationsJson: "integrations.json",
  llmsTxt: "llms.txt",
  apiCatalog: "api-catalog",
  openapiSchema: "openapi-schema",
  mcpServerCard: "mcp-server-card",
  oauthProtectedResource: "oauth-protected-resource",
  agentCard: "agent-card",
  agentSkills: "agent-skills",
} as const;

type ProbeKey = (typeof PROBE_KEYS)[keyof typeof PROBE_KEYS];

export type ConventionStatus = "found" | "missing" | "unprobed";

export interface ConventionRow {
  key: ProbeKey;
  label: string;
  path: string;
  status: ConventionStatus;
  detail: string;
  valueUrl?: string;
  docsHref?: string;
}

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike => !!value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value: RecordLike, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function pathUrl(domain: string, path: string): string {
  return `https://${domain}${path}`;
}

function pathsText(paths: readonly string[]): string {
  if (paths.length <= 1) return paths[0] ?? "";
  return `${paths.slice(0, -1).join(", ")}, or ${paths[paths.length - 1]}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function wasProbed(detect: RecordLike | null, key: ProbeKey): boolean {
  if (!detect) return false;
  const probed = stringArray(detect.probed);
  if (probed.length) return probed.includes(key);
  // Legacy detect rows predate explicit probe bookkeeping. All original probes
  // ran when a detect object exists; integrations.json is the new additive one.
  if (key === PROBE_KEYS.integrationsJson) return hasOwn(detect, "integrationsJson");
  return true;
}

function missingDetail(path: string): string {
  return `Nothing at ${path}`;
}

function unprobedDetail(): string {
  return "Not probed yet";
}

function row(
  detect: RecordLike | null,
  key: ProbeKey,
  label: string,
  path: string,
  found: (() => { detail: string; valueUrl?: string } | null),
  docsHref?: string,
): ConventionRow {
  if (!wasProbed(detect, key)) {
    return { key, label, path, status: "unprobed", detail: unprobedDetail(), docsHref };
  }
  const hit = found();
  if (hit) return { key, label, path, status: "found", ...hit, docsHref };
  return { key, label, path, status: "missing", detail: missingDetail(path), docsHref };
}

export function buildConventionRows(detectValue: unknown, domain: string): ConventionRow[] {
  const detect = isRecord(detectValue) ? detectValue : null;
  const docsHref = "/own-your-page/";

  return [
    row(
      detect,
      PROBE_KEYS.integrationsJson,
      "integrations.json",
      INTEGRATIONS_JSON_PATH,
      () => {
        const value = detect?.integrationsJson;
        if (!isRecord(value)) return null;
        const url = typeof value.url === "string" ? value.url : pathUrl(domain, INTEGRATIONS_JSON_PATH);
        return { detail: url, valueUrl: url };
      },
      docsHref,
    ),
    row(detect, PROBE_KEYS.llmsTxt, "llms.txt", LLMS_TXT_PATH, () => {
      if (detect?.llmsTxt !== true) return null;
      const url = pathUrl(domain, LLMS_TXT_PATH);
      return { detail: url, valueUrl: url };
    }, docsHref),
    row(detect, PROBE_KEYS.apiCatalog, "API catalog", `${API_CATALOG_PATH} (RFC 9727)`, () => {
      const catalog = isRecord(detect?.apiCatalog) ? detect.apiCatalog : null;
      if (!catalog) return null;
      const counts = [
        stringArray(catalog.rest).length ? plural(stringArray(catalog.rest).length, "REST link") : "",
        stringArray(catalog.openapi).length ? plural(stringArray(catalog.openapi).length, "OpenAPI link") : "",
        stringArray(catalog.docs).length ? plural(stringArray(catalog.docs).length, "docs link") : "",
        stringArray(catalog.mcp).length ? plural(stringArray(catalog.mcp).length, "MCP link") : "",
      ].filter(Boolean);
      const url = pathUrl(domain, API_CATALOG_PATH);
      return { detail: counts.length ? `${url} (${counts.join(", ")})` : url, valueUrl: url };
    }, docsHref),
    row(detect, PROBE_KEYS.openapiSchema, "OpenAPI document", pathsText(OPENAPI_PROBE_PATHS), () => {
      const schema = isRecord(detect?.apiSchema) ? detect.apiSchema : null;
      const url = typeof schema?.url === "string" ? schema.url : undefined;
      if (!url) return null;
      const version = typeof schema?.version === "string" ? ` (${schema.version})` : "";
      return { detail: `${url}${version}`, valueUrl: url };
    }, docsHref),
    row(detect, PROBE_KEYS.mcpServerCard, "MCP server card", MCP_SERVER_CARD_PATH, () => {
      const mcp = Array.isArray(detect?.mcp) ? detect.mcp : [];
      const serverCard = mcp.find((item) => isRecord(item) && item.source === "server-card") as RecordLike | undefined;
      const endpoint = typeof serverCard?.url === "string" ? serverCard.url : undefined;
      if (!endpoint) return null;
      return { detail: endpoint, valueUrl: endpoint };
    }, docsHref),
    row(detect, PROBE_KEYS.oauthProtectedResource, "OAuth protected resource", OAUTH_PROTECTED_RESOURCE_PATH, () => {
      const auth = isRecord(detect?.auth) ? detect.auth : null;
      const oauth = isRecord(auth?.oauth) ? auth.oauth : null;
      if (!oauth) return null;
      const protectedResourceUrl = typeof oauth.protectedResourceUrl === "string" ? oauth.protectedResourceUrl : pathUrl(domain, OAUTH_PROTECTED_RESOURCE_PATH);
      const servers = stringArray(oauth.authorizationServers);
      return { detail: servers.length ? `${protectedResourceUrl} -> ${servers.join(", ")}` : protectedResourceUrl, valueUrl: protectedResourceUrl };
    }, docsHref),
    row(detect, PROBE_KEYS.agentCard, "Agent card", AGENT_CARD_PATH, () => {
      const card = isRecord(detect?.agentCard) ? detect.agentCard : null;
      if (!card) return null;
      const url = typeof card.url === "string" ? card.url : pathUrl(domain, AGENT_CARD_PATH);
      const name = typeof card.name === "string" ? card.name : "agent card";
      return { detail: `${name} (${url})`, valueUrl: url };
    }, docsHref),
    row(detect, PROBE_KEYS.agentSkills, "Agent skills", AGENT_SKILLS_PATH, () => {
      const skills = isRecord(detect?.agentSkills) ? detect.agentSkills : null;
      const count = typeof skills?.count === "number" ? skills.count : 0;
      if (!skills || !count) return null;
      const names = stringArray(skills.names).slice(0, 4);
      const url = pathUrl(domain, AGENT_SKILLS_PATH);
      return { detail: names.length ? `${plural(count, "skill")}: ${names.join(", ")}` : plural(count, "skill"), valueUrl: url };
    }, docsHref),
  ];
}
