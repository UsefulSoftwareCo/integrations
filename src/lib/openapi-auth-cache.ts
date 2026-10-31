import { createHash } from "node:crypto";

/** Cache key for a spec's auth summary: the URL, plus a hash of the curated
 *  JSON Patch when one rewrites the document's security. */
export function specAuthKey(url: string, overrides?: readonly unknown[]): string {
  if (!overrides?.length) return url;
  return `${url}#${createHash("sha256").update(JSON.stringify(overrides)).digest("hex").slice(0, 12)}`;
}

const unescape = (seg: string) => seg.replaceAll("~1", "/").replaceAll("~0", "~");

/** Minimal RFC 6902 (add / replace / remove), enough for the curated spec
 *  overrides. Returns a patched deep copy; a path that does not resolve is
 *  skipped rather than thrown, matching how a client tolerates a stale patch. */
export function applyJsonPatch(doc: unknown, ops: readonly unknown[]): unknown {
  const root = structuredClone(doc) as Record<string, unknown>;
  for (const raw of ops) {
    if (typeof raw !== "object" || raw === null) continue;
    const { op, path, value } = raw as { op?: string; path?: string; value?: unknown };
    if (typeof path !== "string" || !path.startsWith("/")) continue;
    const segs = path.slice(1).split("/").map(unescape);
    const last = segs.pop()!;
    let parent: unknown = root;
    for (const s of segs) {
      parent = typeof parent === "object" && parent !== null ? (parent as Record<string, unknown>)[s] : undefined;
    }
    if (typeof parent !== "object" || parent === null) continue;
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (op === "remove") parent.splice(i, 1);
      else if (op === "add") parent.splice(i, 0, value);
      else if (op === "replace") parent[i] = value;
      continue;
    }
    const obj = parent as Record<string, unknown>;
    if (op === "remove") delete obj[last];
    else if (op === "add" || op === "replace") obj[last] = value;
  }
  return root;
}
