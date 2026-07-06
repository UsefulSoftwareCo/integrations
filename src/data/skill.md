---
name: integrations-sh
description: Find how to integrate with any service — its APIs, MCP servers, GraphQL endpoints, and CLIs, each mapped to the credentials it needs. Use when connecting an agent or app to a third-party service, choosing between integration surfaces, or working out what auth a service requires and where to mint it.
---

# integrations.sh

integrations.sh is an open registry of integration surfaces: for thousands of
services it answers "what does this service expose to agents, and exactly how
do I authenticate to each interface?" Every fact is tagged with its basis —
`detected` (machine-verified signal), `discovered` (read from docs by an
agent), or `declared` (published by the service owner) — so you know how much
to trust it.

All endpoints are public, no API key, CORS `*`, JSON.

## Workflow

**1. Search** when you have a service name, not a domain:

```
GET https://integrations.sh/api/search?q=stripe&limit=5
```

Optional `kind=mcp|openapi|graphql|cli` narrows to one surface type. Results
are domain-level: `{ domain, name, description, kinds[], url }`.

**2. Read the surface document** — the main lookup. One call returns every
known surface for a domain plus its auth requirements:

```
GET https://integrations.sh/api/stripe.com/surface
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

A 404 means the domain isn't cataloged yet — escalate to step 3.

**3. Detect / discover** when the surface document is missing or stale:

```
GET https://integrations.sh/api/{domain}/detect     # fast, deterministic probe
GET https://integrations.sh/api/{domain}/discover   # full agentic discovery
```

`detect` checks well-known manifests (`.well-known/integrations.json`, MCP
server cards, `llms.txt`, OpenAPI catalogs) and live capabilities. `discover`
runs an LLM-backed crawl of the service's docs; it takes up to a minute and is
**rate-limited to 3 requests per 60s per IP** — call it once per domain and
reuse the result, never in a loop.

## Choosing a surface

When a service exposes several surfaces, prefer in order: an official MCP
server (agent-native), an OpenAPI-specced HTTP API (typed, tool-compilable),
GraphQL, then CLI. Prefer surfaces whose auth basis is `declared` or
`detected` over `discovered` when they conflict.

## CLI

If the `integrations` CLI is installed (`npm i -g integrationsdotsh`), it
wraps the same API with agent-friendly output — pipe or pass `--json` for
machine-readable output:

```
integrations search stripe --json
integrations stripe.com          # surface lookup
integrations detect resend.com
```

## MCP server

integrations.sh is itself reachable over MCP (streamable HTTP, public):

```
claude mcp add --transport http integrations https://integrations.sh/mcp
```

Tools: `detect { domain }`, `discover { domain }`.

## Bulk data

- `https://integrations.sh/api.json` — full registry index (~5k records)
- `https://integrations.sh/api/domains.json` — all domains with format counts
- `https://integrations.sh/openapi.json` — this API's own spec
