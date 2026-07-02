/**
 * Surfaces — the integration map for a domain page.
 *
 * Renders the kind sections (MCP servers / REST · OpenAPI / GraphQL / CLI) from
 * discovery data only: SSR/baseline discovery, durable KV read on mount, or the
 * live discovery run. Credentials render once at the bottom. Auth lives WITH
 * each surface, not in a separate "Authentication" block.
 *
 * Types come from the canonical Effect Schema (`import type`, so `effect` never
 * enters the client bundle).
 */
import { useEffect, useState } from "react";
import { buildConventionRows, type ConventionRow } from "../lib/conventions.ts";
import type { Credential, DiscoveryResult } from "../lib/discovery-schema.ts";
import { buildSections, discoveryFreshness, type DiscoverData, type SurfaceEntry } from "../lib/surface-sections.ts";
import { cliLoginFor, credCta, hostOf, type AuthStatus, type Basis, type Surface } from "../lib/surface-view.ts";
import Setup from "./surface/Setup.tsx";

type Creds = DiscoveryResult["credentials"];
type StoredDiscoveryEnvelope = { result?: DiscoverData; discoveredAt?: string };

function Prov({ p }: { p: Basis }) {
  if (!p) return null;
  if (p.via === "detected") {
    return (
      <span className="disc-prov disc-prov-det" title={`Detected via ${p.signal} — re-verifiable`}>
        detected
      </span>
    );
  }
  if (p.via === "declared") {
    return (
      <span className="disc-prov disc-prov-decl" title="Declared by the site owner via integrations.json">
        declared
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

function ConventionDetail({ row }: { row: ConventionRow }) {
  if (row.status === "found") {
    return row.valueUrl ? (
      <a className="conv-link conv-url" href={row.valueUrl} target="_blank" rel="noopener">
        {row.detail}
      </a>
    ) : (
      <span className="conv-url">{row.detail}</span>
    );
  }
  if (row.status === "unprobed") {
    return (
      <span className="conv-path" title={row.detailTitle}>
        {row.detail}
      </span>
    );
  }
  return (
    <code className="conv-path">{row.detail}</code>
  );
}

function Conventions({ rows }: { rows: ConventionRow[] }) {
  const found = rows.filter((row) => row.status === "found").length;
  const probed = rows.filter((row) => row.status !== "unprobed").length;
  return (
    <details className="disc-conv" id="conventions">
      <summary className="conv-summary">
        <span className="sec-label conv-summary-text">
          conventions · {found}/{probed} published
        </span>
      </summary>
      <ul className="conv-list">
        {rows.map((row) => (
          <li className="conv-row" key={row.key}>
            {row.specHref ? (
              <a className="conv-name" href={row.specHref} target="_blank" rel="noopener">
                {row.label}
              </a>
            ) : (
              <span className="conv-name">{row.label}</span>
            )}
            <span className={`conv-status conv-status-${row.status}`} aria-label={row.status}>
              {row.status === "found" ? "✓" : row.status === "missing" ? "✗" : "—"}
            </span>
            <span className="conv-detail">
              <ConventionDetail row={row} />
            </span>
          </li>
        ))}
      </ul>
      <p className="conv-owner">
        Publish these signals → <a href="/publishing/">/publishing</a>
      </p>
    </details>
  );
}

function EntryRow({ e }: { e: SurfaceEntry }) {
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

function DiscoveryMeta({ discoveredAt, hasSurfaces, onRun }: { discoveredAt?: string; hasSurfaces: boolean; onRun: () => void }) {
  const freshness = discoveryFreshness(discoveredAt, hasSurfaces);
  // Unknown-age data (timestampless baselines) shows no age claim at all —
  // just the regenerate affordance.
  return (
    <div className="disc-freshness" title={freshness.title}>
      {freshness.known && <span>discovered {freshness.label}</span>}
      {freshness.shouldRegenerate && (
        <button className="conv-action disc-regenerate" onClick={onRun}>
          regenerate
        </button>
      )}
    </div>
  );
}

function normalizeStoredDiscovery(stored: StoredDiscoveryEnvelope): DiscoverData | null {
  if (!stored?.result?.surfaces) return null;
  return {
    ...stored.result,
    discoveredAt: stored.result.discoveredAt ?? stored.discoveredAt,
  };
}

export default function Surfaces({
  domain,
  initialData = null,
}: {
  domain: string;
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
        const result = normalizeStoredDiscovery((await r.json()) as StoredDiscoveryEnvelope);
        if (result) {
          setData(result);
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
  const built = buildSections(activeData, domain);
  const conventions = buildConventionRows(activeData?.detect, domain);
  const creds: Creds = activeData?.credentials ?? {};
  const hasSurfaceData = (data?.surfaces?.length ?? 0) > 0;
  const credIdsOf = (auth?: AuthStatus): string[] =>
    auth?.status === "required" ? auth.entries.flatMap((e) => e.use.map((u) => u.id)) : [];
  const usedCredIds = new Set<string>(built.flatMap((sec) => sec.entries.flatMap((e) => credIdsOf(e.surface.auth))));
  const allAuths = built.flatMap((sec) => sec.entries.map((e) => e.surface.auth));
  const credList = Object.entries(creds)
    .filter(([id]) => usedCredIds.has(id))
    .map(([id, c]) => ({ id, cred: c, cliLogin: cliLoginFor(id, allAuths) }));

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
      {state === "done" && hasSurfaceData && <DiscoveryMeta discoveredAt={data?.discoveredAt} hasSurfaces={hasSurfaceData} onRun={run} />}

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
          {credList.map(({ id, cred: c, cliLogin }) => (
            <div className="disc-cred" key={id}>
              <div className="disc-cred-head">
                <span className="disc-cred-label">{c.label}</span>
                <span className="disc-ctype">{c.type}</span>
                {cliLogin ? (
                  <code className="disc-cred-cli">$ {cliLogin}</code>
                ) : (
                  c.generateUrl && (
                    <a className="disc-cred-get" href={c.generateUrl} target="_blank" rel="noopener noreferrer" title={hostOf(c.generateUrl)}>
                      {credCta(c.type)} ↗
                    </a>
                  )
                )}
              </div>
              {cliLogin ? (
                <p className="disc-cred-clinote">Acquired by the CLI — running <code>{cliLogin}</code> opens the auth flow and stores the credential.</p>
              ) : (
                c.setup && <Setup md={c.setup} />
              )}
            </div>
          ))}
        </section>
      )}

      <Conventions rows={conventions} />
    </div>
  );
}
