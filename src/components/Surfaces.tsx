/**
 * Surfaces — the integration map for a domain page.
 *
 * Renders the kind sections (MCP servers / REST · OpenAPI / GraphQL / CLI) from
 * TWO sources merged: the static catalog (passed as props, SSR'd for SEO) and
 * the discovery result (read from durable KV on mount, or run live). A
 * discovered surface enriches the matching catalog entry with its auth (matched
 * on url/spec, else name); discovered-only surfaces are appended. Credentials
 * render once at the bottom. Auth lives WITH each surface, not in a separate
 * "Authentication" block.
 *
 * Types come from the canonical Effect Schema (`import type`, so `effect` never
 * enters the client bundle).
 */
import { useEffect, useState } from "react";
import type { Basis, Credential, Surface, AuthStatus, DiscoveryResult } from "../lib/discovery-schema.ts";
import { credCta, hostOf, slugifySurface } from "../lib/surface-view.ts";
import Setup from "./surface/Setup.tsx";

export type DiscoverData = Partial<Pick<DiscoveryResult, "summary" | "credentials" | "surfaces">>;
type Creds = DiscoveryResult["credentials"];

/** A static catalog entry, pre-flattened by the page (identity for dedup). */
export interface CatalogItem {
  name: string;
  description?: string;
  slug: string;
  kind: string;
  meta: string;
  url?: string;
  spec?: string;
}
export interface CatalogSection {
  kind: string;
  label: string;
  items: CatalogItem[];
}

const KIND_ORDER = ["mcp", "openapi", "graphql", "cli"] as const;
const KIND_LABEL: Record<string, string> = { mcp: "MCP servers", openapi: "REST · OpenAPI", graphql: "GraphQL", cli: "CLI" };
/** surface.type → page section kind (rest folds into openapi). */
const kindOf = (t: string): string => (t === "rest" ? "openapi" : t);
const norm = (s: string) => s.trim().toLowerCase();

function surfaceIdentity(s: Surface): string | undefined {
  switch (s.type) {
    case "mcp":
      return s.url;
    case "graphql":
      return s.url ?? s.spec;
    case "openapi":
    case "rest":
      return s.spec ?? s.url;
    case "cli":
      return undefined;
  }
}

function surfaceMeta(s: Surface): string {
  switch (s.type) {
    case "mcp":
      return s.transports?.[0] ?? "mcp";
    case "graphql":
      return "graphql";
    case "openapi":
    case "rest":
      return "rest";
    case "cli":
      return s.command ?? "cli";
  }
}

/** Does a discovered surface refer to the same thing as a catalog entry? */
function matches(s: Surface, it: CatalogItem): boolean {
  const id = surfaceIdentity(s);
  if (id && (id === it.url || id === it.spec)) return true;
  return norm(s.name) === norm(it.name);
}

function Prov({ p }: { p: Basis }) {
  if (!p) return null;
  if (p.via === "detected") {
    return (
      <span className="disc-prov disc-prov-det" title={`Detected via ${p.signal} — re-verifiable`}>
        detected
      </span>
    );
  }
  const n = p.evidence?.length ?? 0;
  return (
    <span className="disc-prov disc-prov-disc" title={n ? `Read from: ${p.evidence.join(", ")}` : "Read from docs"}>
      discovered
    </span>
  );
}

interface Entry {
  key: string;
  name: string;
  href?: string;
  meta?: string;
  surface?: Surface;
}

/** Merge catalog + discovered surfaces into per-kind sections. A discovered
 * surface (matched or standalone) links to its worker-SSR'd page; a pure-catalog
 * surface keeps its static `/{kind}/{slug}/` detail page. */
function buildSections(catalog: CatalogSection[], data: DiscoverData | null, domain: string) {
  const surfaces = data?.surfaces ?? [];
  const discPage = (s: Surface) => `/${encodeURIComponent(domain)}/${slugifySurface(s.name)}/`;
  const catByKind = new Map(catalog.map((s) => [s.kind, s.items]));
  const out: { kind: string; label: string; entries: Entry[] }[] = [];
  for (const kind of KIND_ORDER) {
    const items = catByKind.get(kind) ?? [];
    const discovered = surfaces.filter((s) => kindOf(s.type) === kind);
    const used = new Set<number>();
    const entries: Entry[] = items.map((it, i) => {
      const di = discovered.findIndex((s, idx) => !used.has(idx) && matches(s, it));
      if (di >= 0) {
        used.add(di);
        return { key: `c${i}`, name: it.name, href: discPage(discovered[di]), meta: it.meta, surface: discovered[di] };
      }
      // Catalog-only surface — its detail page is served from the baseline JSON
      // by the same `/{domain}/{slug}/` route (worker), keyed by its name.
      return { key: `c${i}`, name: it.name, href: `/${encodeURIComponent(domain)}/${slugifySurface(it.name)}/`, meta: it.meta };
    });
    discovered.forEach((s, idx) => {
      if (!used.has(idx)) entries.push({ key: `d${idx}`, name: s.name, href: discPage(s), meta: surfaceMeta(s), surface: s });
    });
    if (entries.length) out.push({ kind, label: KIND_LABEL[kind], entries });
  }
  return out;
}

function EntryRow({ e }: { e: Entry }) {
  return (
    <li className="disc-entry">
      <div className="disc-entry-head">
        {e.href ? (
          <a className="disc-ename" href={e.href}>
            {e.name}
          </a>
        ) : (
          <span className="disc-ename disc-ename-static">{e.name}</span>
        )}
        {e.surface && <Prov p={e.surface.basis} />}
        {e.meta && <span className="disc-emeta">{e.meta}</span>}
      </div>
    </li>
  );
}

export default function Surfaces({
  domain,
  catalog = [],
  initialData = null,
}: {
  domain: string;
  catalog?: CatalogSection[];
  /** Stored discovery baked in by the SSR'd domain page — the island then
   * hydrates directly into "done" with no fetch and no idle-button flash. */
  initialData?: DiscoverData | null;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(initialData ? "done" : "idle");
  const [data, setData] = useState<DiscoverData | null>(initialData);
  const [progress, setProgress] = useState("");
  const [liveCreds, setLiveCreds] = useState<Record<string, Credential>>({});
  const [liveSurfaces, setLiveSurfaces] = useState<Surface[]>([]);

  // On mount, load any durably-stored discovery so returning visitors see the
  // enriched map without re-running the agent. Skipped when the server already
  // baked it in (initialData) — that's the SSR path's whole point.
  useEffect(() => {
    if (initialData) return;
    let cancelled = false;
    fetch(`/api/${encodeURIComponent(domain)}/discovery`)
      .then(async (r) => {
        if (cancelled || !r.ok) return;
        const stored = (await r.json()) as { result?: DiscoverData };
        if (stored?.result?.surfaces) {
          setData(stored.result);
          setState("done");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [domain, initialData]);

  async function run() {
    // The site's key conversion — posthog is the snippet global from
    // src/lib/analytics.ts (absent on localhost, hence the guard).
    (window as { posthog?: { capture: (e: string, p?: Record<string, unknown>) => void } }).posthog?.capture("map_surface_clicked", { domain });
    setState("loading");
    setProgress("Starting…");
    setLiveCreds({});
    setLiveSurfaces([]);
    const surfaceKeys = new Set<string>();
    try {
      const res = await fetch(`/api/${encodeURIComponent(domain)}/discover/stream`);
      if (!res.ok || !res.body) throw new Error();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          let ev = "message";
          let dat = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) dat += line.slice(5).trim();
          }
          if (!dat) continue;
          let parsed: { message?: string; id?: string; credential?: Credential; type?: string; name?: string; spec?: string; url?: string };
          try {
            parsed = JSON.parse(dat);
          } catch {
            continue;
          }
          if (ev === "progress") {
            setProgress(parsed.message ?? "");
          } else if (ev === "credential" && parsed.id && parsed.credential) {
            const { id, credential } = parsed;
            setLiveCreds((c) => ({ ...c, [id]: credential }));
          } else if (ev === "surface") {
            const key = `${parsed.type}|${(parsed.spec || parsed.url || parsed.name || "").toLowerCase()}`;
            if (!surfaceKeys.has(key)) {
              surfaceKeys.add(key);
              setLiveSurfaces((s) => [...s, parsed as unknown as Surface]);
            }
          } else if (ev === "done") {
            setData(parsed as unknown as DiscoverData);
            setState("done");
            finished = true;
          } else if (ev === "error") {
            setState("error");
            finished = true;
          }
        }
      }
      reader.cancel().catch(() => {});
      if (!finished) setState("error");
    } catch {
      setState("error");
    }
  }

  const activeData: DiscoverData | null =
    state === "loading" ? { credentials: liveCreds, surfaces: liveSurfaces } : state === "done" ? data : null;
  const built = buildSections(catalog, activeData, domain);
  const creds: Creds = activeData?.credentials ?? {};
  const credIdsOf = (auth?: AuthStatus): string[] =>
    auth?.status === "required" ? auth.entries.flatMap((e) => e.use.map((u) => u.id)) : [];
  const usedCredIds = new Set<string>(built.flatMap((sec) => sec.entries.flatMap((e) => credIdsOf(e.surface?.auth))));
  const credList = Object.entries(creds).filter(([id]) => usedCredIds.has(id));

  return (
    <div className="disc">
      {state === "idle" && (
        <div className="auth-cta">
          <p className="auth-cta-text">
            Map how to integrate with <b>{domain}</b> — every API, MCP server, and CLI, and how to authenticate to each.
          </p>
          <button className="auth-btn" onClick={run}>
            Map integration surface →
          </button>
        </div>
      )}
      {state === "loading" && (
        <div className="auth-loading">
          <span className="auth-spinner" aria-hidden="true" />
          <span className="auth-loading-text">{progress || "Working…"}</span>
          <span className="auth-loading-sub">Reading {domain}'s docs live.</span>
        </div>
      )}
      {state === "error" && (
        <div className="auth-loading">
          <span className="auth-loading-text">Couldn't reach the detector.</span>
          <button className="auth-btn" onClick={run}>
            Retry
          </button>
        </div>
      )}
      {state === "done" && data?.summary && <p className="disc-summary">{data.summary}</p>}

      {built.map((sec) => (
        <section className="disc-sec" id={sec.kind} key={sec.kind}>
          <div className="sec-header">
            <span className="sec-label">{sec.label}</span>
            <span className="sec-note">{sec.entries.length}</span>
          </div>
          <ul className="disc-list">
            {sec.entries.map((e) => (
              <EntryRow key={e.key} e={e} />
            ))}
          </ul>
        </section>
      ))}

      {credList.length > 0 && (
        <section className="disc-sec disc-creds">
          <div className="sec-header">
            <span className="sec-label">Credentials</span>
          </div>
          {credList.map(([id, c]) => (
            <div className="disc-cred" key={id}>
              <div className="disc-cred-head">
                <span className="disc-cred-label">{c.label}</span>
                <span className="disc-ctype">{c.type}</span>
                {c.generateUrl && (
                  <a className="disc-cred-get" href={c.generateUrl} target="_blank" rel="noopener noreferrer" title={hostOf(c.generateUrl)}>
                    {credCta(c.type)} ↗
                  </a>
                )}
              </div>
              {c.setup && <Setup md={c.setup} />}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
