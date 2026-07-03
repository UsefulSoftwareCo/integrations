/**
 * 404 island. Client-only — reads the attempted path from the URL.
 *
 * If it looks like a domain (e.g. /notion.so/), this IS the live "discover it"
 * page: same structure as a real domain page (breadcrumb + favicon header), no
 * sources listed, and the Surfaces island's "Map integration surface →" button
 * to go get them. Anything else gets a plain not-found.
 */
import { useEffect, useState } from "react";
import Surfaces from "./Surfaces.tsx";
import { faviconFor } from "~/lib/favicon.ts";

/** First path segment, if it looks like a registrable domain. */
function domainFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const seg = decodeURIComponent(window.location.pathname.split("/").filter(Boolean)[0] ?? "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(seg) ? seg.toLowerCase() : null;
}

export default function NotFound() {
  const [domain, setDomain] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const d = domainFromPath();
    setDomain(d);
    setReady(true);
    // This 404 doubles as the live discover page — title it like a real
    // domain page (DomainPage.astro) instead of "Not found".
    if (d) document.title = `${d} — integrations`;
  }, []);

  if (!ready) return null;

  if (!domain) {
    return (
      <div className="nf">
        <nav className="crumb" aria-label="Breadcrumb">
          <a href="/">registry</a>
        </nav>
        <h1 className="nf-h">Page not found</h1>
        <p className="nf-sub">That page doesn't exist. Head back to the registry to browse or search every integration.</p>
        <a className="auth-btn" href="/">← Back to the registry</a>
      </div>
    );
  }

  const letter = (domain[0] ?? "?").toUpperCase();
  return (
    <>
      <nav className="crumb" aria-label="Breadcrumb">
        <a href="/">registry</a>
        <span className="sep">/</span>
        <span>{domain}</span>
      </nav>
      <header className="head">
        <div className="favicon">
          <span className="fav-letter">{letter}</span>
          <img
            src={faviconFor(domain)}
            width="22"
            height="22"
            alt=""
            loading="lazy"
            onError={(e) => (e.currentTarget as HTMLImageElement).remove()}
          />
        </div>
        <div>
          <h1>{domain}</h1>
          <p className="meta">Not in the registry yet</p>
        </div>
      </header>
      <Surfaces domain={domain} />
    </>
  );
}
