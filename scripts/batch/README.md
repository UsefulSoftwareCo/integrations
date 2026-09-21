# Discovery catalog operations

This directory now supports the current discovery data flow:

- `sync-kv.ts` pulls DISCOVERY KV rows into the repo's per-domain `domains/` tree.
- `load-kv.ts` seeds local KV from a directory of `StoredDiscovery` JSON rows during development.
- `validate-results.ts` is a manual data-quality tool for the `domains/` tree or a local `StoredDiscovery` row directory.

All commands are Bun scripts and support `--help`.

## Sync KV to the repo

```sh
bun scripts/batch/sync-kv.ts --dry-run
bun scripts/batch/sync-kv.ts
```

Use `--local` to read local Wrangler KV instead of production KV:

```sh
bun scripts/batch/sync-kv.ts --local --dry-run
```

The sync writes `domains/<canonical-domain>/integrations.json`. It unions by canonical domain, keeps the repo copy when KV has no row for that domain, and only replaces an existing file when the incoming row has a newer `discoveredAt`.

Rejected domains never enter: the sync drops incoming rows for denylisted
domains and junk hosting hosts (`*.vercel.app`, `*.run.app`, …), counts them in
the summary, and deletes any `domains/` file left over for a denylisted domain.

## Reject a record

**Deleting `domains/<domain>/integrations.json` does not reject anything.** The
row is still in KV, so the next nightly sync writes the file back.

To reject a record, add it to `catalog-denylist.json` at the repo root:

```jsonc
{ "domain": "example-host.run.app", "reason": "Why this is not a real record.", "addedAt": "2026-09-21" }
```

One entry is enough. The next sync removes the file, the build and the render
paths skip the domain, and `bun run validate:batch` fails if a file for a
denylisted (or junk-host) domain reappears. An entry also covers subdomains.

## Validate catalog data

Validate the repo catalog tree:

```sh
bun run validate:batch
```

Validate a local directory of full `StoredDiscovery` rows before loading KV:

```sh
bun scripts/batch/validate-results.ts --results-dir path/to/results
```

The validator checks bad URL slugs, duplicate surfaces, missing auth status, and missing locators required by the surface detail page.

## Seed local KV

```sh
bun scripts/batch/load-kv.ts --dir path/to/results --dry-run
bun scripts/batch/load-kv.ts --dir path/to/results
```

The loader defaults to local KV. Production writes require `--remote`; remote rows are not overwritten unless `--overwrite` is passed.

## Export a result directory

`export-catalog.ts` is a manual importer for a directory of `StoredDiscovery` rows:

```sh
bun scripts/batch/export-catalog.ts --results-dir path/to/results
```

It writes compact per-domain files into `domains/` and omits credentials, notes, and other discovery-only details.
