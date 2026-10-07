---
name: integrations-sh
description: Use the `integrations` CLI to find how to integrate with any service — its APIs, MCP servers, GraphQL endpoints, and CLIs, each mapped to the credentials it needs. Use when connecting an agent or app to a third-party service, choosing between integration surfaces, or working out what auth a service requires and where to mint it.
---

# integrations.sh CLI

The `integrations` CLI queries integrations.sh, an open registry that answers
"what does this service expose to agents, and exactly how do I authenticate
to each interface?" for thousands of services.

Run it with npx (no install needed):

```sh
npx integrations search stripe
```

Or install once: `npm i -g integrations` — the command is `integrations`.

**Output contract**: when stdout is piped (or `--json` is passed), every
command emits exactly one JSON document on stdout; diagnostics go to stderr.
You are almost always piping — parse the JSON, don't scrape text.

## Workflow

**1. Search** when you have a service name, not a domain:

```sh
integrations search stripe --json
integrations search "issue tracking" --kind mcp --json
```

`--kind mcp|openapi|graphql|cli` narrows to one surface type, `--limit` caps
results. Results are domain-level: `{ domain, name, description, kinds[], url }`.

**2. Look up the domain** — the main call. One lookup returns every known
surface for a service plus its auth requirements:

```sh
integrations stripe.com --json
```

How to read the response:

- `surfaces[]` is a discriminated union on `type`:
  - `http` — REST API; `spec` is the OpenAPI spec URL, `url` the base URL
  - `graphql` — `url` is the endpoint, `spec` optional schema
  - `mcp` — `url` is the connect endpoint, plus `transports`
  - `cli` — `command` name and `packages[]` install options
- `credentials` is a registry keyed by id; surfaces reference these ids.
  Each credential has a `type` (`api_key`, `bearer`, `oauth2`, `basic`, …),
  a `generateUrl` (where to mint it), and `setup` (markdown acquisition
  steps).
- Each surface's `auth`: `status: "none"` means confirmed public;
  `status: "required"` lists `entries[]` — **alternatives (OR)** — where each
  entry's `use[]` lists credentials needed **together (AND)**;
  `status: "unknown"` means not yet determined.

For a Google `http` surface, fetch its `spec` to choose narrower OAuth scopes.
Each operation's `x-google-scopes` lists the scopes Google accepts for it;
any **one** of them is enough. The order is not a privilege ranking, and
importers keep requesting the broad scopes in `security`, so pick the
narrowest scope yourself. The `x-google-scopes` map on the `googleOAuth2`
security scheme describes each scope. Example: to list and read Gmail
messages, request `https://www.googleapis.com/auth/gmail.readonly`, not
`https://mail.google.com/` (`gmail.metadata` also lists messages but can't
read their bodies).

Not found means the domain isn't cataloged yet — escalate to step 3.

**3. Detect / discover** when the lookup came back empty or stale:

```sh
integrations detect acme.com --json      # fast, deterministic probe
integrations discover acme.com --json    # full agentic discovery
```

`detect` checks the domain's well-known manifests (`integrations.json`, MCP
server cards, `llms.txt`, OpenAPI catalogs) and live capabilities. `discover`
runs a doc-reading agent server-side; it can take up to a minute and is
**rate-limited to 3 requests per 60s** — call it once per domain and reuse
the result, never in a loop.

Every fact in the registry carries a `basis` tag: `detected`
(machine-verified signal), `discovered` (read from docs by an agent), or
`declared` (published by the service owner). Trust `declared`/`detected`
over `discovered` when they conflict.

## Choosing a surface

When a service exposes several surfaces, prefer in order: an official MCP
server (agent-native), an OpenAPI-specced HTTP API (typed, tool-compilable),
GraphQL, then CLI.

## More commands

- `integrations help` — the full command list (the CLI grows automatically
  as the API does; `integrations help <cmd>` for flags)
- `integrations mcp` — connection snippets for the hosted MCP server, if you
  prefer MCP tools over shelling out
- `integrations skill` — prints this skill (for self-install:
  `integrations skill > ~/.claude/skills/integrations-sh/SKILL.md`)
- `--no-cache` bypasses the cached API description; `INTEGRATIONS_BASE`
  points the CLI at another host

## Without the CLI

The same data is plain HTTPS (public, no key, CORS `*`):
`https://integrations.sh/api/search?q=…`, `/api/{domain}/surface`,
`/api/{domain}/detect`, `/api/{domain}/discover`, bulk index at `/api.json`,
spec at `/openapi.json`, MCP server at `https://integrations.sh/mcp`
(streamable-http; tools `detect` and `discover`).
