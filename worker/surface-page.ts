/**
 * Worker-SSR'd detail page for a DISCOVERED surface.
 *
 * Discovered surfaces live in KV (not the static catalog), so they have no
 * pre-built page. The worker renders one on demand from the stored result at
 * `/{domain}/{surface-slug}/` — name, locator, and the per-surface auth
 * (which credential, how bound) + the referenced credentials.
 *
 * Everything interpolated comes from the LLM agent, so every value is escaped.
 * Chrome (tokens, nav, footer, atoms) comes from the shared src/lib/chrome.ts —
 * the SAME source Base.astro uses — so the static and SSR'd pages never drift.
 */
import { GLOBAL_CSS, FONT_HEAD, navHtml, footerHtml, FOOTER_JS, ANALYTICS_JS } from "../src/lib/chrome.ts";

// Loose shapes (the value is parsed KV JSON; the schema is the source of truth).
interface Mechanics {
  source: string;
  scheme?: string;
  in?: string;
  headerName?: string;
  paramName?: string;
  command?: string;
  env?: string[];
  url?: string;
}
interface CredentialUse {
  id: string;
  mechanics: Mechanics;
}
interface Basis {
  via: string;
  signal?: string;
  evidence?: string[];
}
interface AuthEntry {
  use: CredentialUse[];
  basis: Basis;
}
type AuthStatus = { status: "none"; basis: Basis } | { status: "required"; entries: AuthEntry[] } | { status: "unknown" };
interface Credential {
  type: string;
  label: string;
  generateUrl?: string;
  setup: string;
}
export interface Surface {
  name: string;
  type: string;
  docs?: string;
  basis: Basis;
  auth: AuthStatus;
  spec?: string;
  url?: string;
  transports?: string[];
  packages?: { registryType: string; identifier: string; runtimeHint?: string }[];
  command?: string;
}

export function slugifySurface(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const STYPE: Record<string, string> = { openapi: "OpenAPI", rest: "REST", graphql: "GraphQL", mcp: "MCP", cli: "CLI" };

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function mechanicsLine(m: Mechanics): string {
  switch (m.source) {
    case "spec":
      return `OpenAPI scheme · ${m.scheme || "see spec"}`;
    case "well-known":
      return "OAuth · resolves from well-known metadata";
    case "metadata":
      return `OAuth · metadata at ${hostOf(m.url)}`;
    case "inline":
      if (m.command) return `$ ${m.command}`;
      if (m.env && m.env.length) return `env ${m.env.join(", ")}`;
      if (m.in === "query") return `?${m.paramName ?? "api_key"}=<credential>`;
      if (m.in === "body") return `${m.paramName ?? "api_key"}=<credential>`;
      return `${m.headerName ?? "Authorization"}: ${m.scheme ? `${m.scheme} ` : ""}<credential>`;
    default:
      return "mechanics not captured";
  }
}

function provBadge(b?: Basis): string {
  if (!b) return "";
  if (b.via === "detected") return `<span class="prov prov-det" title="Detected via ${esc(b.signal)} — re-verifiable">detected</span>`;
  const n = b.evidence?.length ?? 0;
  return `<span class="prov prov-disc" title="${n ? `Read from: ${esc(b.evidence!.join(", "))}` : "Read from docs"}">discovered</span>`;
}

/** Minimal safe markdown for credential setup: ## headers, **bold**, `code`, [links](url). */
function setupHtml(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return "";
      if (t.startsWith("#")) return `<div class="setup-h">${inlineMd(t.replace(/^#+\s*/, ""))}</div>`;
      return `<p class="setup-p">${inlineMd(t)}</p>`;
    })
    .join("");
}

function inlineMd(text: string): string {
  return text
    .split(/(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((tok) => {
      let m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (m) return `<a class="lnk" href="${esc(m[2])}" target="_blank" rel="noopener noreferrer">${esc(m[1])}</a>`;
      if ((m = /^`([^`]+)`$/.exec(tok))) return `<code class="ic">${esc(m[1])}</code>`;
      if ((m = /^\*\*([^*]+)\*\*$/.exec(tok))) return `<strong>${esc(m[1])}</strong>`;
      return esc(tok);
    })
    .join("");
}

function authHtml(auth: AuthStatus, creds: Record<string, Credential>): string {
  if (auth.status === "none") return `<div class="auth-row auth-none"><span class="auth-use">No auth — public</span>${provBadge(auth.basis)}</div>`;
  if (auth.status === "unknown") return `<p class="muted">Authentication not yet determined.</p>`;
  return auth.entries
    .map((e) => {
      const uses = e.use
        .map((u) => `<span class="use"><span class="cred">${esc(creds[u.id]?.label ?? u.id)}</span><code class="mech">${esc(mechanicsLine(u.mechanics))}</code></span>`)
        .join(`<span class="and">+</span>`);
      return `<div class="auth-row"><span class="auth-use">${uses}</span>${provBadge(e.basis)}</div>`;
    })
    .join("");
}

function credsHtml(used: string[], creds: Record<string, Credential>): string {
  const list = used.filter((id, i) => used.indexOf(id) === i && creds[id]);
  if (!list.length) return "";
  const items = list
    .map((id) => {
      const c = creds[id];
      const get = c.generateUrl ? `<a class="lnk cred-get" href="${esc(c.generateUrl)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.generateUrl))} ↗</a>` : "";
      return `<div class="cred-card"><div class="cred-head"><span class="cred-label">${esc(c.label)}</span><span class="ctype">${esc(c.type)}</span>${get}</div>${c.setup ? `<div class="setup">${setupHtml(c.setup)}</div>` : ""}</div>`;
    })
    .join("");
  return `<section><div class="sec-header"><span class="sec-label">Credentials</span></div>${items}</section>`;
}

/** A `claude mcp add` / install one-liner, when we have what we need. */
function connectCmd(domain: string, surface: Surface): { label: string; cmd: string } | null {
  if (surface.type === "mcp" && surface.url) {
    return { label: "Connect", cmd: `claude mcp add --transport http ${slugifySurface(surface.name)} ${surface.url}` };
  }
  if (surface.type === "cli") {
    const p = surface.packages?.[0];
    if (p) return { label: "Install", cmd: p.runtimeHint === "npx" ? `npx ${p.identifier}` : `${p.registryType === "npm" ? "npm i -g" : p.registryType} ${p.identifier}` };
  }
  return null;
}

/** The `dl.kv` details block — the surface's own facts. */
function detailsHtml(surface: Surface): string {
  const rows: string[] = [];
  const row = (k: string, v: string) => rows.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`);
  const link = (u: string, label?: string) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(label ?? u)}</a>`;
  if (surface.url) row(surface.type === "mcp" || surface.type === "graphql" ? "Endpoint" : "URL", `<code>${esc(surface.url)}</code>`);
  if (surface.transports?.length) row("Transport", esc(surface.transports.join(", ")));
  if (surface.spec) row("Spec", surface.spec === "introspection" ? "introspection" : link(surface.spec, hostOf(surface.spec) || "spec"));
  if (surface.command) row("Command", `<code>${esc(surface.command)}</code>`);
  if (surface.docs) row("Docs", link(surface.docs));
  if (!rows.length) return "";
  return `<section><div class="sec-header"><span class="sec-label">Details</span></div><dl class="kv">${rows.join("")}</dl></section>`;
}

/** Surface-detail styles NOT in the shared chrome (auth rows, credential cards, setup prose). */
const SURFACE_CSS = `
section{margin-top:48px;max-width:760px}
.code-block{margin:16px 0 0;white-space:pre-wrap;word-break:break-all}
.auth-row{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;padding:13px 0;border-bottom:1px solid var(--gray-100)}
.auth-use{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 9px}
.use{display:inline-flex;align-items:baseline;gap:6px}.and{font-family:var(--font-mono);font-size:12px;color:var(--gray-400)}
.cred{font-size:13.5px;color:var(--gray-1000);font-weight:500}
.mech{font-family:var(--font-mono);font-size:12px;color:var(--gray-700);background:var(--gray-25);border:1px solid var(--gray-100);border-radius:5px;padding:1px 6px;word-break:break-all}
.auth-none .auth-use{font-size:13px;color:var(--gray-500);font-weight:400}.muted{color:var(--gray-400);font-size:13.5px;margin:14px 0 0}
.prov{margin-left:auto;font-family:var(--font-mono);font-size:10px;letter-spacing:0.03em;text-transform:uppercase;padding:1px 5px;border-radius:4px}
.prov-det{color:var(--gray-700);border:1px solid var(--gray-200)}.prov-disc{color:var(--gray-400)}
.cred-card{border:1px solid var(--gray-100);border-radius:10px;padding:14px 18px;margin-top:12px}
.cred-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.cred-label{font-size:14px;font-weight:600}
.ctype{font-family:var(--font-mono);font-size:10px;color:var(--gray-500);border:1px solid var(--gray-200);border-radius:4px;padding:1px 5px}
.cred-get{margin-left:auto;font-family:var(--font-mono);font-size:11.5px}
.setup{margin-top:10px}.setup-h{font-size:13px;font-weight:600;color:var(--gray-1000);margin:8px 0 4px}.setup-h:first-child{margin-top:0}
.setup-p{margin:4px 0;font-size:13.5px;color:var(--gray-700);line-height:1.6}
.ic{font-family:var(--font-mono);font-size:12px;color:var(--gray-700);background:var(--gray-25);border:1px solid var(--gray-100);border-radius:4px;padding:0 4px}
.lnk{color:var(--gray-1000);text-decoration:none}.lnk:hover{text-decoration:underline;text-underline-offset:2px}
`;

export function renderSurfacePage(domain: string, surface: Surface, creds: Record<string, Credential>, stars: number | null = null): string {
  const usedIds = surface.auth.status === "required" ? surface.auth.entries.flatMap((e) => e.use.map((u) => u.id)) : [];
  const title = `${surface.name} — ${STYPE[surface.type] ?? surface.type}`;
  const letter = esc((surface.name[0] ?? "?").toUpperCase());
  const connect = connectCmd(domain, surface);
  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(`${surface.name} on ${domain}: a ${STYPE[surface.type] ?? surface.type} surface and how to authenticate.`)}">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FONT_HEAD}
<script>${ANALYTICS_JS}</script>
<style>${GLOBAL_CSS}${SURFACE_CSS}</style></head><body>
<div class="frame-guides"></div>
${navHtml(stars)}
<main><div class="container">
<nav class="crumb" aria-label="Breadcrumb"><a href="/">registry</a><span class="sep">/</span><a href="/${esc(domain)}/">${esc(domain)}</a><span class="sep">/</span><span>${esc(surface.name)}</span></nav>
<header class="head">
<div class="favicon"><span class="fav-letter">${letter}</span><img src="https://${esc(domain)}/favicon.ico" width="22" height="22" alt="" loading="lazy" onerror="this.remove()"></div>
<div><h1>${esc(surface.name)}</h1><p class="meta"><span>${esc(STYPE[surface.type] ?? surface.type)}</span>${provBadge(surface.basis)}</p></div>
</header>
${connect ? `<section><div class="sec-header"><span class="sec-label">${esc(connect.label)}</span></div><pre class="code-block">${esc(connect.cmd)}</pre></section>` : ""}
<section><div class="sec-header"><span class="sec-label">Authentication</span></div>${authHtml(surface.auth, creds)}</section>
${credsHtml(usedIds, creds)}
${detailsHtml(surface)}
</div></main>
${footerHtml()}
<script>${FOOTER_JS}</script>
</body></html>`;
}
