export type DedupCollapse = { domain: string; dropped: string; kept: string };

type JsonObject = Record<string, unknown>;

type SurfaceLike = JsonObject & {
  type?: string;
  name?: string;
  docs?: string | null;
  notes?: string | null;
  auth?: { status?: string; entries?: unknown[] };
  url?: string | null;
  spec?: string | null;
  specAlternates?: string[] | null;
  command?: string | null;
  packages?: Array<{ identifier?: string | null }>;
};

type CredentialLike = JsonObject & {
  id?: string;
  type?: string;
  label?: string | null;
  generateUrl?: string | null;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeLocator(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function surfaceDedupKey(surface: SurfaceLike): string {
  const type = surface.type ?? "unknown";
  // http/graphql specs collapse across format: the same API published as
  // openapi.json AND openapi.yaml (resend does this) is ONE surface, so the
  // spec locator drops its extension before keying.
  const locator =
    type === "cli"
      ? (surface.command ?? surface.packages?.[0]?.identifier)
      : type === "http" || type === "graphql"
        ? (stripSpecExt(surface.spec) ?? surface.url)
        : type === "mcp"
          ? surface.url
          : undefined;
  // Distinct APIs can share one base url (hanko's Public + Flow APIs on the
  // tenant host). A url-only key merges them wrongly — qualify with the name;
  // spec-keyed and name-keyed surfaces keep exact-collision semantics.
  if ((type === "http" || type === "graphql") && !surface.spec && surface.url) {
    return `${type}|${normalizeLocator(surface.url)}|${normalizeLocator(surface.name)}`;
  }

  return `${type}|${normalizeLocator(locator) || normalizeLocator(surface.name)}`;
}

function stripSpecExt(spec: string | null | undefined): string | undefined {
  if (typeof spec !== "string") return undefined;
  return spec.replace(/\.(json|ya?ml)(?=[/?#]|$)/i, "");
}

function isJsonSpec(spec: string | null | undefined): spec is string {
  return typeof spec === "string" && /\.json(?=[/?#]|$)/i.test(spec);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function credentialKey(credential: CredentialLike): string {
  return `${credential.type ?? "unknown"}|${normalizeLocator(credential.generateUrl) || normalizeLocator(credential.label)}`;
}

function authRank(surface: SurfaceLike): number {
  const status = surface.auth?.status;
  if (status === "required") return 3;
  if (status === "none") return 2;
  return 1;
}

function populatedCount(value: unknown): number {
  if (value === undefined || value === null || value === false) return 0;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  if (typeof value !== "object") return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + populatedCount(item), value.length ? 1 : 0);
  return Object.values(value).reduce((sum, item) => sum + populatedCount(item), 0);
}

function shouldPrefer(candidate: SurfaceLike, current: SurfaceLike): boolean {
  const rankDelta = authRank(candidate) - authRank(current);
  if (rankDelta !== 0) return rankDelta > 0;
  return populatedCount(candidate) > populatedCount(current);
}

function mechanicsSource(use: unknown): string {
  if (!use || typeof use !== "object") return "";
  const mechanics = (use as { mechanics?: { source?: unknown } }).mechanics;
  return typeof mechanics?.source === "string" ? mechanics.source : "";
}

function authEntryKey(entry: unknown): string {
  if (!entry || typeof entry !== "object") return JSON.stringify(entry);
  const use = Array.isArray((entry as { use?: unknown }).use) ? (entry as { use: unknown[] }).use : [];
  const parts = use
    .map((item) => {
      const id = item && typeof item === "object" ? String((item as { id?: unknown }).id ?? "") : "";
      return `${id}:${mechanicsSource(item)}`;
    })
    .sort();
  return parts.join("|");
}

function unionAuthEntries(a: unknown[] | undefined, b: unknown[] | undefined): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of [...(a ?? []), ...(b ?? [])]) {
    const key = authEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function mergeSurface(kept: SurfaceLike, dropped: SurfaceLike): SurfaceLike {
  const keep = shouldPrefer(dropped, kept) ? dropped : kept;
  const other = keep === kept ? dropped : kept;
  const merged: SurfaceLike = { ...other, ...keep };
  if (merged.type === "http" || merged.type === "graphql") {
    const primary = isJsonSpec(keep.spec) ? keep.spec : isJsonSpec(other.spec) ? other.spec : (keep.spec ?? other.spec);
    const candidates = [...stringArray(keep.specAlternates), ...stringArray(other.specAlternates), other.spec, keep.spec];
    if (primary) merged.spec = primary;
    const primaryKey = normalizeLocator(primary);
    const seen = new Set<string>();
    const alternates: string[] = [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const key = normalizeLocator(candidate);
      if (!key || key === primaryKey || seen.has(key)) continue;
      seen.add(key);
      alternates.push(candidate);
    }
    if (alternates.length) merged.specAlternates = alternates;
    else delete merged.specAlternates;
  }
  if (!merged.docs && other.docs) merged.docs = other.docs;
  if (!merged.notes && other.notes) merged.notes = other.notes;
  if (keep.auth?.status === "required" || other.auth?.status === "required") {
    const keepEntries = keep.auth?.status === "required" ? keep.auth.entries : [];
    const otherEntries = other.auth?.status === "required" ? other.auth.entries : [];
    merged.auth = { ...(keep.auth ?? other.auth), status: "required", entries: unionAuthEntries(keepEntries, otherEntries) };
  }
  return merged;
}

function credentialsArray(credentials: unknown): CredentialLike[] {
  if (Array.isArray(credentials)) return credentials as CredentialLike[];
  if (credentials && typeof credentials === "object") {
    return Object.entries(credentials).map(([id, credential]) => ({ id, ...(credential as JsonObject) }));
  }
  return [];
}

function rewriteAuthIds(surface: SurfaceLike, ids: Map<string, string>): void {
  if (surface.auth?.status !== "required" || !Array.isArray(surface.auth.entries)) return;
  for (const entry of surface.auth.entries) {
    const use = entry && typeof entry === "object" ? (entry as { use?: unknown }).use : undefined;
    if (!Array.isArray(use)) continue;
    for (const item of use) {
      if (!item || typeof item !== "object") continue;
      const ref = (item as { id?: unknown }).id;
      if (typeof ref === "string" && ids.has(ref)) (item as { id: string }).id = ids.get(ref)!;
    }
  }
}

export function dedupSurfacesWithReport<T>(result: T, domain = (result as { domain?: string })?.domain ?? "unknown"): { result: T; collapses: DedupCollapse[] } {
  const next = clone(result) as T & { surfaces?: SurfaceLike[]; credentials?: unknown };
  const collapses: DedupCollapse[] = [];
  const surfaces = Array.isArray(next.surfaces) ? next.surfaces : [];
  const byKey = new Map<string, number>();
  const deduped: SurfaceLike[] = [];
  for (const surface of surfaces) {
    const key = surfaceDedupKey(surface);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, deduped.length);
      deduped.push(surface);
      continue;
    }
    const existing = deduped[existingIndex]!;
    // Multiple product APIs can share ONE spec document (edmunds ships four
    // APIs in one openapi.yaml, each with its own docs page). Both sides
    // carrying DIFFERENT docs pages means distinct products — keep both. A
    // missing docs on either side means the same API described twice
    // (mintlify/resend twins) and merges as usual.
    if (
      (surface.type === "http" || surface.type === "graphql") &&
      surface.spec && existing.spec &&
      surface.docs && existing.docs &&
      normalizeLocator(surface.docs) !== normalizeLocator(existing.docs)
    ) {
      byKey.set(`${key}|${normalizeLocator(surface.docs)}`, deduped.length);
      deduped.push(surface);
      continue;
    }
    const preferDropped = shouldPrefer(surface, existing);
    const keptBeforeMerge = preferDropped ? surface : existing;
    const droppedBeforeMerge = preferDropped ? existing : surface;
    const merged = mergeSurface(existing, surface);
    deduped[existingIndex] = merged;
    const kept = String(keptBeforeMerge.name ?? surfaceDedupKey(keptBeforeMerge));
    const dropped = String(droppedBeforeMerge.name ?? surfaceDedupKey(droppedBeforeMerge));
    collapses.push({ domain, dropped, kept });
  }

  // An url-less mcp stub whose NAME matches an url-bearing mcp is the same
  // server recorded at lower confidence — merge the stub in.
  for (let i = deduped.length - 1; i >= 0; i--) {
    const stub = deduped[i]!;
    if (stub.type !== "mcp" || stub.url) continue;
    const target = deduped.find((other) => other !== stub && other.type === "mcp" && other.url && normalizeLocator(other.name) === normalizeLocator(stub.name));
    if (!target) continue;
    const merged = mergeSurface(target, stub);
    deduped[deduped.indexOf(target)] = merged;
    deduped.splice(i, 1);
    collapses.push({ domain, dropped: String(stub.name ?? "mcp stub"), kept: String(merged.name ?? "mcp") });
  }

  const idRewrite = new Map<string, string>();
  const credentials: CredentialLike[] = [];
  const credentialByKey = new Map<string, number>();
  for (const credential of credentialsArray(next.credentials)) {
    if (!credential.id) continue;
    const key = credentialKey(credential);
    const existingIndex = credentialByKey.get(key);
    if (existingIndex === undefined) {
      credentialByKey.set(key, credentials.length);
      credentials.push(credential);
      continue;
    }
    const existing = credentials[existingIndex]!;
    idRewrite.set(credential.id, existing.id!);
    credentials[existingIndex] = populatedCount(credential) > populatedCount(existing) ? { ...existing, ...credential, id: existing.id } : existing;
  }
  for (const surface of deduped) rewriteAuthIds(surface, idRewrite);

  next.surfaces = deduped;
  next.credentials = Array.isArray(next.credentials)
    ? credentials
    : Object.fromEntries(credentials.map((credential) => {
      const { id: _id, ...rest } = credential;
      return [credential.id, rest];
    }));
  return { result: next, collapses };
}

export function dedupSurfaces<T>(result: T): T {
  return dedupSurfacesWithReport(result).result;
}
