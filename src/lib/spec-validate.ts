export type SpecValidationResult =
  | { ok: true; kind: string }
  | { ok: false; reason: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const YAML_HEAD_BYTES = 4 * 1024;
const ACCEPT = "application/json, application/yaml;q=0.9, */*;q=0.1";

export function sniffOpenApiDocument(contentType: string | null, head: string): "openapi-json" | "openapi-yaml" | undefined {
  if (isHtml(contentType, head)) return undefined;
  const json = parseJson(head, contentType);
  if (json && isRecord(json) && (hasOwn(json, "openapi") || hasOwn(json, "swagger"))) return "openapi-json";
  if (/^(openapi|swagger)\s*:/im.test(head.slice(0, YAML_HEAD_BYTES))) return "openapi-yaml";
  return undefined;
}

export function sniffOpenApiHead(contentType: string | null, head: string): "openapi-json" | "openapi-yaml" | undefined {
  if (isHtml(contentType, head)) return undefined;
  const kind = sniffOpenApiDocument(contentType, head);
  if (kind) return kind;
  return /["']?(?:openapi|swagger)["']?\s*:/.test(head) ? "openapi-json" : undefined;
}

export async function validateSpecUrl(
  url: string,
  type: "http" | "graphql",
  fetchImpl: FetchLike = fetch,
): Promise<SpecValidationResult> {
  if (type === "graphql" && url === "introspection") return { ok: true, kind: "introspection" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "the spec value is not a valid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "the spec URL must use http or https" };
  }
  if (isOAuthUrl(parsed)) return { ok: false, reason: "that is an OAuth endpoint, not a spec" };

  const hit = await fetchHead(url, fetchImpl);
  if (!hit) return { ok: false, reason: "the URL could not be fetched or timed out" };
  // A locked door is not a wrong document: an auth challenge means the spec
  // endpoint exists but needs a credential (common for graphql SDL endpoints
  // and private OpenAPI docs). Accept it rather than bouncing the model.
  if (hit.res.status === 401 || hit.res.status === 403 || hit.res.headers.has("www-authenticate")) {
    return { ok: true, kind: "auth-gated" };
  }
  // GraphQL endpoints often reject GET outright — introspection rides POST.
  if (type === "graphql" && hit.res.status === 405) return { ok: true, kind: "auth-gated" };
  if (!hit.res.ok) return { ok: false, reason: `the URL did not return a document (HTTP ${hit.res.status})` };

  const contentType = hit.res.headers.get("content-type");
  const text = hit.text;
  const json = parseJson(text, contentType);

  if (isHtml(contentType, text)) {
    return { ok: false, reason: "that URL serves an HTML page (a docs portal), not a spec document" };
  }
  if (isRecord(json) && isOAuthErrorJson(json)) return { ok: false, reason: "that is an OAuth endpoint, not a spec" };
  if (isPostmanCollection(json)) return { ok: false, reason: "that is a Postman collection, not an OpenAPI spec" };
  if (isAsyncApi(json, text)) {
    return {
      ok: false,
      reason: type === "http" ? "that is an AsyncAPI document; only OpenAPI is accepted for http surfaces" : "that is an AsyncAPI document, not a GraphQL schema",
    };
  }

  if (type === "http") {
    const kind = sniffOpenApiDocument(contentType, text);
    return kind ? { ok: true, kind } : { ok: false, reason: "that document is not a machine-readable OpenAPI spec" };
  }

  if (isRecord(json) && isRecord(json.data) && isRecord(json.data.__schema)) {
    return { ok: true, kind: "graphql-introspection" };
  }
  if (/\b(type|schema|interface|input|enum)\s+\w+/m.test(text)) return { ok: true, kind: "graphql-sdl" };
  return { ok: false, reason: "that document is not a machine-readable GraphQL SDL or introspection schema" };
}

async function fetchHead(url: string, fetchImpl: FetchLike): Promise<{ res: Response; text: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      headers: { accept: ACCEPT },
      signal: ctrl.signal,
    });
    return { res, text: await readPrefix(res, MAX_BYTES) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readPrefix(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - size;
      chunks.push(value.length > remaining ? value.slice(0, remaining) : value);
      size += Math.min(value.length, remaining);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string, contentType: string | null): unknown {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  if (contentType && /text\/html/i.test(contentType)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isHtml(contentType: string | null, text: string): boolean {
  return Boolean(contentType && /text\/html/i.test(contentType)) || /<!doctype\s+html|<html[\s>]/i.test(text.slice(0, 512));
}

function isOAuthUrl(url: URL): boolean {
  return /\/oauth(?:\/|$)|\/authorize(?:[/?#]|$)/i.test(url.pathname);
}

function isOAuthErrorJson(json: Record<string, unknown>): boolean {
  return typeof json.error === "string" && (/oauth|authorization|invalid_(client|request|scope|grant)/i.test(json.error) || typeof json.error_description === "string");
}

function isPostmanCollection(json: unknown): boolean {
  return isRecord(json) && (isRecord(json.info) && typeof json.info._postman_id === "string" || Array.isArray(json.item));
}

function isAsyncApi(json: unknown, text: string): boolean {
  return isRecord(json) && hasOwn(json, "asyncapi") || /^asyncapi\s*:/im.test(text.slice(0, YAML_HEAD_BYTES));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
