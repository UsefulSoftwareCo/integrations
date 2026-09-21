# Dev server

Start/preview via the `.claude/launch.json` entries — don't guess a server
name. `dev` runs the main site (`bun run dev`, port 4321).

Never kill a running dev/preview server unless explicitly asked — the user
may be actively using it. If you need a server and the port is taken, use
another port.

Check `.claude/launch.json` for available server names before starting
anything — never guess names.

# Batch / catalog generation

The scheduled KV sync commits only after `bun run build` passes. For manual
data-quality audits of the repo catalog, run `bun run validate:batch`. For
local StoredDiscovery rows that will be loaded into KV via
`scripts/batch/load-kv.ts`, run `bun scripts/batch/validate-results.ts
--results-dir <dir>` before loading.

`bun run validate:batch` runs `scripts/batch/validate-results.ts`, which
checks for the failure modes that have shipped to the live site before:
slugs/domains that render as literal `/domain/undefined/`, duplicate
(domain, surface-type, name) entries — within one domain's result, across
domain aliases in the `domains/` tree — and surfaces missing the fields their detail page
(`src/pages/[domain]/[surface].astro`) renders unconditionally (name, auth
status, and a locator: url/spec for http+graphql, url for mcp, command or
packages for cli). It also fails when a `domains/` file exists for a denylisted
or junk-host domain, which is how denylist drift is caught.

## Rejecting a catalog record

Never reject a record by deleting `domains/<domain>/integrations.json` — the row
stays in KV and the next nightly sync writes it back. Add the domain to
`catalog-denylist.json` at the repo root instead (domain, reason, addedAt). One
entry is durable: the sync refuses the incoming row and deletes the existing
file, the build skips the domain, and `validate:batch` fails if it returns. See
`scripts/batch/README.md`.

`scripts/verify-mcp-endpoints.ts` probes every catalogued MCP endpoint (the
normalized feeds and the `domains/` tree) and writes `output/mcp-endpoints.json`.
The nightly sync re-probes stale entries and commits that cache with `domains/`.
