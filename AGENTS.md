# Dev server

Start/preview via the `.claude/launch.json` entries — don't guess a server
name. `dev` runs the main site (`bun run dev`, port 4321).

Never kill a running dev/preview server unless explicitly asked — the user
may be actively using it. If you need a server and the port is taken, use
another port.

Check `.claude/launch.json` for available server names before starting
anything — never guess names.

# Batch / catalog generation

After any batch or catalog generation run (`scripts/batch/run-loop.ts`,
`scripts/batch/drive.sh`, `scripts/batch/export-catalog.ts`, or a manual edit
to `scripts/batch/results-full/`, `scripts/batch/results/`, or
`sources/discovered.json`), `bun run validate:batch` must pass before the
results are treated as done or deployed (loaded into KV via
`scripts/batch/load-kv.ts`, or exported into `sources/discovered.json` and
built).

`bun run validate:batch` runs `scripts/batch/validate-results.ts`, which
checks for the failure modes that have shipped to the live site before:
slugs/domains that render as literal `/domain/undefined/`, duplicate
(domain, surface-type, name) entries — within one domain's result, across
domain aliases, and across the static/discovered merge in
`sources/discovered.json` — and surfaces missing the fields their detail page
(`src/pages/[domain]/[surface].astro`) renders unconditionally (name, auth
status, and a locator: url/spec for http+graphql, url for mcp, command or
packages for cli).

`drive.sh` already runs this as its final gate and exits nonzero if it fails.
If you run `run-loop.ts` directly instead of through `drive.sh`, run
`bun run validate:batch` yourself afterward.
