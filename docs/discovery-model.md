# integrations.sh — Discovery Data Model (v3)

The structured payload the discovery agent produces for a service: its
integration **surfaces** (API / GraphQL / MCP / CLI) and how to **authenticate**
to each.

> **v3 changes** (breaking, no dual-version readers): `version: 3` on the
> result; every surface carries a server-assigned **`slug`** — stable identity
> and URL segment (`/{domain}/{slug}/`), preserved across re-runs by locator
> match, never model-authored; `openapi`/`rest` collapsed into one **`http`**
> variant (spec presence already carries the distinction); Mechanics `inline`
> split into **`http`** and **`cli`**; `Basis.detected` gains optional
> `verifiedAt`; `Basis.declared` records owner-published facts from
> `/.well-known/integrations.json`; the KV envelope is typed
> (`StoredDiscovery`).
>
> **v2 changes** (from stress-testing against 18 services + three reference
> schemas): built around **discriminated unions**; surfaces collapsed into one
> typed list; auth vocabulary aligned to Nango; MCP/CLI structure aligned to the
> MCP registry's `server.json`; OR/AND auth semantics fixed. Out of scope (deliberately not modeled): webhooks, SDKs,
> non-HTTP/DB surfaces, and the *execution* of exotic auth flows.

## Prior art (vendored in `.reference/discovery-prior-art/`)

We are not inventing a vocabulary — auth is intrinsically heterogeneous, and the
mature catalogs converge on the same shapes. We borrow from three:

- **Nango** (`nango-auth-api.ts`, `nango-provider.ts`) — 600+ providers. Its
  `Provider` is a **discriminated union on `auth_mode`** (`OAUTH2`, `API_KEY`,
  `BASIC`, `JWT`, `APP`, `TWO_STEP`, `SIGNATURE`, `AWS_SIGV4`, `OAUTH2_CC`,
  `MCP_OAUTH2`…). We adopt that vocabulary for credential `type`.
- **Backstage** (`backstage-API.schema.json`) — `kind: API` with
  `spec.type` ∈ {openapi, graphql, grpc, asyncapi}, `spec.definition`, and
  `spec.lifecycle`. We adopt its typed-surface model.
- **MCP registry `server.json`** (`mcp-server.schema.json`) — `packages[]`
  (registryType / identifier / runtimeHint / environmentVariables) and
  `remotes[]` (transport / url / headers / variables). We adopt these shapes for
  the CLI and MCP surfaces, so we're registry-compatible (and can ingest
  `server.json` directly).

## Design principles

1. **Discriminated unions are the backbone.** Four of them, each keyed by a tag
   so every variant carries only its own fields and a consumer dispatches on the
   tag:
   - **Surface** — discriminated by `type` (`http | graphql | mcp | cli`)
   - **AuthStatus** — discriminated by `status` (`none | required | unknown`)
   - **Mechanics** — discriminated by `source` (`spec | well-known | metadata | http | cli | unknown`)
   - **Basis** — discriminated by `via` (`detected | discovered | declared` — how we learned it)

   (`Credential.type` is a flat `Literals` enum, not a tagged union — the
   Nango-derived auth-mode vocabulary.)

   Adding a case = adding a union member, never bolting optional flags onto a
   catch-all object.
2. **Credentials are global, bindings are per-surface.** A credential is defined
   **once** (what it is, where you get it, the setup prose); each surface that
   accepts it references it by id and adds only its own *binding*.
3. **Store a pointer only when it's non-derivable.** If a value is computable
   from the spec, the URL, or an RFC convention, we resolve it — we store it only
   to *override* a deviation.
4. **Resolve lazily, mark unknowns honestly.** Mechanics that can be read from a
   spec/well-known are pointers; exotic flows we don't execute are *named*
   (recognizable Nango `type`) with `mechanics.source: "inline" | "unknown"` and
   human `setup` prose — never faked.

---

## Top-level result

```jsonc
{
  "domain": "cloudflare.com",
  "summary": "One-line overview of the integration surface.",
  "version": 3,                                 // readers dispatch on this, never shape-sniff
  "credentials": { "<id>": Credential, ... },  // shared registry, defined once
  "surfaces": [ Surface, ... ]                  // ONE typed list; each carries a stable server-assigned `slug`
}
```

---

## Credential  — discriminated union on `type`

*What the thing is and where you get it.* The home of the LLM-authored
acquisition prose. `type` uses Nango's auth-mode vocabulary so the strategy is a
recognized term, even for flows we resolve lazily.

```jsonc
Credential =
  | { type: "api_key" | "bearer" | "basic",  ...base }
  | { type: "oauth2" | "oauth2_cc" | "oauth1", ...base }
  | { type: "jwt" | "app" | "two_step" | "signature" | "aws_sigv4" | "tba", ...base }  // named, executed lazily
  | { type: "compound", fields: { "<name>": { secret?: bool, description? } }, ...base } // e.g. GitHub App's 4 secrets

// ...base (shared by all):
{
  "label": "Cloudflare API token",
  "generateUrl": "https://dash.cloudflare.com/profile/api-tokens",  // where to mint (optional)
  "setup": "## API token\nMarkdown: where you go, what to click, gotchas.",
  "acquisition": "manual | ambient"                                  // optional; ambient = env-injected (GITHUB_TOKEN)
}
```

The exotic Nango types (`app`, `two_step`, `signature`, `aws_sigv4`, `jwt`) are
**named but not executed** by the model — the `setup` prose carries the human
flow; we don't model SigV4 canonicalization or token-exchange steps.

---

## Auth  (on every surface)

A surface carries an **`AuthStatus`** (discriminated on `status`), not a bare
array — so "confirmed public" and "haven't figured it out" stop being the same
empty list:

```jsonc
AuthStatus =
  | { status: "none", basis: Basis }          // confirmed PUBLIC — basis.via:detected (clean unauth probe)
                                              //   outranks discovered (the docs said so)
  | { status: "required", entries: AuthEntry[] }  // OR alternatives — at least one needed
  | { status: "unknown" }                     // not determined (≠ public)
```

### Auth entry — one way in (`use[]` is AND'd, each placed independently)

The key fix vs. earlier drafts: **`mechanics` lives per credential-use**, so two
AND'd credentials can have genuinely different placements (Algolia-style: an
app-id in one header, an api-key in a differently-named one).

```jsonc
AuthEntry  = { use: CredentialUse[], basis: Basis }   // sibling entries are OR
CredentialUse = { id: "<credentialId>", mechanics: Mechanics }  // each bound on its own
```

So: `auth.entries[]` = **OR** alternatives; an entry's `use[]` = **AND** (all
sent together), each with its own `mechanics`.

### Mechanics — discriminated union on `source` (one credential)

`source` doubles as a knowledge-state signal.

```jsonc
Mechanics =
  | { source: "spec", scheme: "api_token" }     // the ONE OpenAPI securityScheme this credential satisfies
                                                //   (the AND of several is carried by use[], not here)
  | { source: "well-known" }                     // derive from surface url via RFC 9728/8414 (MCP OAuth)
  | { source: "metadata", url: "..." }           // well-known at a non-standard location (override)
  | { source: "inline", /* binding fields */ }   // agent-supplied from docs; keys vary by surface kind:
        //   HTTP : in (header|query|body|path), headerName, scheme, paramName
        //   CLI  : command ("wrangler login") | env (["X"])
  | { source: "unknown" }                        // confirmed to exist, mechanics NOT captured
```

`spec`/`well-known`/`metadata`/`inline`(with fields) = known; `unknown` = exists
but unresolved. A `bearer`/`api_key` binding implied by the credential `type`
may omit `mechanics`.

---

## Basis — discriminated union on `via`

*How we learned a thing exists* — a trust/verifiability axis, attached to every
**surface** and every **auth entry**.

```jsonc
Basis =
  | { via: "detected",   signal: "<re-verifiable machine signal>" }   // e.g. ".well-known/api-catalog",
                                                                       //   "oauth-protected-resource",
                                                                       //   "openapi:securitySchemes", "mcp:initialize"
  | { via: "discovered", evidence: ["<doc urls the agent read>"] }     // prose-derived, point-in-time
  | { via: "declared",   source: "https://.../.well-known/integrations.json" } // owner-published
```

- **`detected`** — asserted by a machine-readable signal the service publishes
  (well-known manifest, OpenAPI `securitySchemes`, OAuth metadata, an MCP probe).
  `signal` points at the thing, so it's **re-verifiable** by re-fetching. High trust.
- **`discovered`** — the agent surfaced it by reading human docs / searching.
  `evidence` lists the pages it read. Point-in-time, prose-derived, lower trust.
- **`declared`** — the site owner published it in `/.well-known/integrations.json`.
  `source` is the declaration URL. It is respected as the owner's statement of
  intent and may be enriched or annotated when verified knowledge conflicts.

**Orthogonal to `mechanics.source`** — don't conflate them. Basis is *how we
learned the thing exists*; `mechanics.source` is *where its binding resolves*. A
surface can be `discovered` (agent found the spec URL in docs) yet its auth
resolves from `spec`; an OAuth method can be `detected` (well-known present) yet
have `mechanics.source: "unknown"` (metadata existed but endpoints weren't
captured). They compose: `discovered` + `unknown` = "the agent saw it mentioned
but couldn't pin the mechanics," which is exactly the honest state for a
half-documented API.

---

## Surface  — discriminated union on `type`

All surfaces share a base; each `type` adds its own fields.

```jsonc
// base (every surface):
{ "name": string, "type": "...", "docs": string,
  "basis": Basis,        // how we learned this surface exists
  "auth": AuthStatus,    // none | required(entries[]) | unknown
  "requiredHeaders"?: [{ name, source: {kind:"static",value} | {kind:"env",envVar}, description }],  // version pins (anthropic-version)
  "variables"?: [{ name, in?: "url"|"header"|"query", resolveFrom?, description }] }  // {name} templated into url by default (project_ref → {project_ref}.supabase.co)
```

### `type: "openapi" | "rest"`
```jsonc
{ ...base, "type": "openapi",
  "spec": "https://.../openapi.json" | "none",   // pointer; absent/none → mechanics inline
  "url":  "https://...",                          // ONLY if not derivable from spec `servers`
  "patch"?: { "securitySchemes": { ... } } }      // override when spec is wrong or MISSING a scheme
// baseUrl is NOT stored — it's in spec.servers. patch absent in the happy path.
```

### `type: "graphql"`
```jsonc
{ ...base, "type": "graphql",
  "url": "https://.../graphql",        // REQUIRED — a GraphQL schema has no endpoint
  "spec": "introspection" | "<sdl url>" }
// auth mechanics is ALWAYS `inline` — GraphQL has no security-scheme concept.
```

### `type: "mcp"`  — aligned to `server.json` `remotes`
```jsonc
{ ...base, "type": "mcp",
  "url": "https://mcp.cloudflare.com/mcp",
  "transports": ["streamable-http", "sse"] }       // server.json `remotes[].type`
// OAuth mechanics resolve from the server's well-known metadata (derived from url).
```

### `type: "cli"`  — aligned to `server.json` `packages`
```jsonc
{ ...base, "type": "cli",
  "packages": [                                    // structured, not flat strings (server.json `packages`)
    { "registryType": "npm",  "identifier": "wrangler", "runtimeHint": "npx" },
    { "registryType": "brew", "identifier": "cloudflare-wrangler" }
  ],
  "command": "wrangler" }
// no spec, no well-knowns → every mechanics.source is `inline` (command|env).
```

---

## Worked example (Cloudflare, abridged)

```jsonc
{
  "domain": "cloudflare.com",
  "credentials": {
    "cf_api_token":  { "type": "api_key", "label": "Cloudflare API token",
                       "generateUrl": "https://dash.cloudflare.com/profile/api-tokens", "setup": "## API token\n…" },
    "cf_oauth":      { "type": "oauth2",  "label": "OAuth (Cloudflare account)", "setup": "## OAuth\n…" },
    "cf_auth_email": { "type": "api_key", "label": "Account email", "setup": "## Email\nYour Cloudflare account email — paired with the Global API Key." },
    "cf_global_key": { "type": "api_key", "label": "Global API Key (legacy)", "setup": "## Global API Key\n…" }
  },
  "surfaces": [
    { "name": "Cloudflare API", "type": "openapi",
      "spec": "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json", "docs": "…",
      "basis": { "via": "detected", "signal": ".well-known/api-catalog" },
      "auth": { "status": "required", "entries": [
        { "use": [{ "id": "cf_api_token", "mechanics": { "source": "spec", "scheme": "api_token" } }],
          "basis": { "via": "detected", "signal": "openapi:securitySchemes#api_token" } },
        { "use": [{ "id": "cf_oauth", "mechanics": { "source": "unknown" } }],
          "basis": { "via": "discovered", "evidence": ["https://developers.cloudflare.com/fundamentals/oauth/"] } },
        { "use": [                                    // ← AND: two creds, each in its OWN header
            { "id": "cf_auth_email", "mechanics": { "source": "spec", "scheme": "api_email" } },
            { "id": "cf_global_key", "mechanics": { "source": "spec", "scheme": "api_key" } }
          ],
          "basis": { "via": "detected", "signal": "openapi:securitySchemes#api_email+api_key" } }
      ] } },
    { "name": "Cloudflare API MCP", "type": "mcp",
      "url": "https://mcp.cloudflare.com/mcp", "transports": ["streamable-http", "sse"], "docs": "…",
      "basis": { "via": "detected", "signal": "mcp:initialize" },
      "auth": { "status": "required", "entries": [
        { "use": [{ "id": "cf_oauth", "mechanics": { "source": "well-known" } }],
          "basis": { "via": "detected", "signal": "oauth-protected-resource" } },
        { "use": [{ "id": "cf_api_token", "mechanics": { "source": "inline", "in": "header", "scheme": "Bearer" } }],
          "basis": { "via": "discovered", "evidence": ["https://developers.cloudflare.com/agents/model-context-protocol/"] } }
      ] } },
    { "name": "Wrangler", "type": "cli",
      "packages": [ { "registryType": "npm", "identifier": "wrangler", "runtimeHint": "npx" } ], "command": "wrangler", "docs": "…",
      "basis": { "via": "discovered", "evidence": ["https://developers.cloudflare.com/workers/wrangler/"] },
      "auth": { "status": "required", "entries": [
        { "use": [{ "id": "cf_oauth", "mechanics": { "source": "inline", "command": "wrangler login" } }],
          "basis": { "via": "discovered", "evidence": ["https://developers.cloudflare.com/workers/wrangler/commands/"] } },
        { "use": [{ "id": "cf_api_token", "mechanics": { "source": "inline", "env": ["CLOUDFLARE_API_TOKEN"] } }],
          "basis": { "via": "discovered", "evidence": ["https://developers.cloudflare.com/workers/wrangler/system-environment-variables/"] } }
      ] } }
  ]
}
```

`cf_api_token` is defined **once** and bound three ways (spec scheme / inline
header / env var); `cf_oauth` is the same credential resolved differently per
surface (`unknown` on REST, `well-known` on MCP, `wrangler login` on CLI).

Basis shows the axis is independent: the REST surface is `detected`
(api-catalog) but its OAuth method is `discovered` + `unknown` (mentioned in
docs, endpoints never pinned); the MCP surface is `detected` with a `detected`
OAuth method, yet its token binding is `discovered` from prose. A consumer can
trust the `detected` rows, re-verify them from `signal`, and treat `discovered`
rows as agent-read.

---

## Deliberately NOT modeled

- **Webhooks** (inbound HMAC verification) — different direction; out of scope.
- **SDKs** — out of scope (would be another surface `type` if added).
- **Non-HTTP** (DB connection strings, gRPC, WebSocket) — out of scope.
- **Exotic-flow execution** — SigV4 canonicalization, App JWT→token exchange,
  STS. We *name* the credential `type` (Nango) and write `setup` prose; we don't
  model the steps. Mechanics stays `inline`/`unknown`.
- **ttl / refresh / per-route auth** — optional prose, not structural fields.
