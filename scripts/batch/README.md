# Discovery bulk runner

This directory contains two discovery backfill paths:

- `run-loop.ts` is the primary runner. It executes the same `detect()` -> `discover()` agentic tool loop -> Worker packing/slug path that the website uses, backed by context.dev and sync OpenAI chat completions.
- `corpus.ts`, `submit.ts`, and `collect.ts` are the older one-shot OpenAI Batch API alternative. They are useful for prompt-only experiments, but they do not run the multi-turn website loop.

All commands are Bun scripts and support `--help`.

## Primary path: live loop

Prepare a domain list, one domain per line or comma-separated:

```sh
bun scripts/batch/expand-domains.ts
```

Run the website discovery loop in bulk:

```sh
bun scripts/batch/run-loop.ts \
  --domains scripts/batch/domains-all.txt \
  --model gpt-5.4-mini \
  --concurrency 8 \
  --out scripts/batch/results \
  --existing path/to/current-kv-rows
```

Requirements:

- `OPENAI_API_KEY`
- `CONTEXT_DEV_API_KEY`

Both are loaded through `shared.ts` `envValue`: `process.env`, then `.dev.vars`, then `~/.config/connectors/secrets.env`. The runner hard-fails before work starts if either is missing. It never uses `naiveWeb`.

Behavior:

- skips existing `results/{domain}.json` files unless `--force` is passed
- writes failures to `results/_failures.jsonl` and continues
- writes `StoredDiscovery` rows with `model: loop-{model}` plus a sibling `usage` object
- preserves existing slugs by the same locator matching used by the Worker
- runs `dedupSurfaces` after packing and logs any collapses
- prints one progress row per domain: surfaces, credentials, turns, tokens, seconds

Check the output:

```sh
bun scripts/batch/check-results.ts --dir scripts/batch/results/
```

`check-results.ts` scores each domain's discovery quality (grounding, checklist).
Before treating a run as done or loading it into KV, also run the structural
gate — it catches problems `check-results.ts` doesn't look for: undefined/empty
slugs that would render as `/domain/undefined/`, duplicate (domain, type, name)
entries (within a result, across domain aliases, and across the
static+discovered merge in `sources/discovered.json`), and surfaces missing
fields the detail page renders unconditionally:

```sh
bun run validate:batch
# or directly:
bun scripts/batch/validate-results.ts --results-dir scripts/batch/results-full
```

`drive.sh` runs this automatically as its final step and exits nonzero if it fails.

If a matching corpus file exists, URL grounding uses the corpus. If not, live-loop output is checked against the result evidence URLs, same registrable domain, and detected machine signals.

Load KV:

```sh
bun scripts/batch/load-kv.ts --dir scripts/batch/results/ --dry-run
bun scripts/batch/load-kv.ts --dir scripts/batch/results/
```

The loader defaults to local KV. Production requires `--remote`. Remote rows are not overwritten unless `--overwrite` is passed.

## Sync cost math

`run-loop.ts` reports observed input/output tokens per domain. Price an observed run with:

```text
cost = input_tokens / 1_000_000 * input_rate + output_tokens / 1_000_000 * output_rate
```

Sync chat-completions rates:

| Model | Input | Output |
| --- | ---: | ---: |
| `gpt-5.4-mini` | `$0.75/M` | `$4.50/M` |
| `gpt-5.4` | `$2.50/M` | `$15.00/M` |
| `gpt-5.5` | `$5.00/M` | `$30.00/M` |

## Batch API alternative

The Batch API cannot execute the multi-turn tool loop. Use this path only for the one-shot corpus prompt/eval workflow.

Build a scrape corpus:

```sh
bun scripts/batch/corpus.ts --domains scripts/batch/domains-all.txt --out scripts/batch/corpus/
```

Dry-run or submit batch requests:

```sh
bun scripts/batch/submit.ts --corpus scripts/batch/corpus/ --dry-run
bun scripts/batch/submit.ts --corpus scripts/batch/corpus/
```

Collect and validate outputs:

```sh
bun scripts/batch/collect.ts --state scripts/batch/state.json --existing path/to/current-kv-rows
```

Evaluate a small one-shot sample:

```sh
head -50 scripts/batch/domains-all.txt > /tmp/discovery-sample.txt
bun scripts/batch/corpus.ts --domains /tmp/discovery-sample.txt --out scripts/batch/corpus-sample/
bun scripts/batch/submit.ts --corpus scripts/batch/corpus-sample/ --dry-run
bun scripts/batch/eval-discovery.ts --domains resend.com --corpus scripts/batch/corpus-sample/
```
