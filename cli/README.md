# integrations

CLI for [integrations.sh](https://integrations.sh).

```sh
npx integrations search stripe
```

Install globally with `npm i -g integrations`; the command is `integrations`.

## Quickstart

```sh
integrations search stripe
integrations stripe.com
integrations detect resend.com
integrations help surface
```

`search` accepts a service name. A bare domain such as `stripe.com` is treated
as a surface lookup.

## Agent Output

For API-backed commands, stdout is human-readable only when attached to a TTY.
When stdout is piped or `--json` is passed, stdout is exactly one JSON document.
Diagnostics go to stderr. Errors in JSON mode print this shape to stdout and
exit non-zero:

```json
{"error":"unknown flag --example"}
```

Examples:

```sh
integrations search stripe | jq .
integrations stripe.com --json
```

`integrations skill` is the exception: it prints markdown by default so it can
be redirected into an agent skill file. Use `integrations skill --json` for the
structured form.

## Skill

Print the bundled integrations.sh agent skill:

```sh
integrations skill
integrations skill --json
```

Install it for Claude-style skill loaders:

```sh
mkdir -p ~/.claude/skills/integrations-sh
integrations skill > ~/.claude/skills/integrations-sh/SKILL.md
```

## MCP

Print connection details for the hosted public MCP server:

```sh
integrations mcp
integrations mcp --json
```

Claude Code:

```sh
claude mcp add --transport http integrations https://integrations.sh/mcp
```

The JSON form is:

```json
{"url":"https://integrations.sh/mcp","transport":"streamable-http","tools":["detect","discover"]}
```

## Commands

The API command surface is derived from `https://integrations.sh/openapi.json`
at runtime. Operation IDs become kebab-case commands, path parameters become
positional arguments, query parameters become flags, and enum/boolean parameters
are validated locally.

```sh
integrations help
integrations help search
integrations help discover
```

Current public operations include `search`, `detect`, `discover`, and `surface`.
As the OpenAPI spec adds operations, the CLI picks them up without a release.

`discover` can take up to a minute and is rate-limited by the hosted API to 3
requests per 60 seconds per IP.

## Base URL and Cache

Set `INTEGRATIONS_BASE` to target another compatible host:

```sh
INTEGRATIONS_BASE=http://localhost:4321 integrations help
```

The OpenAPI spec is cached in the system temp directory using the server TTL and
ETag. Use `--no-cache` to bypass the cache for one invocation:

```sh
integrations search stripe --no-cache
```

## Build

```sh
bun run typecheck
bun run build
bun test
```

## Credits

Thanks to [Zachary Kirby](https://www.zkirby.com/) for the `integrations`
package name on npm.
