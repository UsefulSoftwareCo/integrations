# Overnight run journal (2026-07-02, ~03:30)

## State
- batch-01 (200 domains) running on PRE-base-url-nudge prompt, results healthy
  (67 done, 2 checklist fails, 2 loop failures). locatorless_http elevated (~107)
  — expected to drop from batch-02 onward (prompt fix c74bb0d).
- batches 02-16 will run via scripts/batch/drive.sh (gates: >25% loop fail or
  >20% checklist fail stops the driver).
- Concurrency 2 due to 200K TPM org limit (bump expected in the morning; then
  raise to 6-8 via drive.sh arg).
- results in scripts/batch/results-full/. Sample (100 dom) in results-mini/.

## Taste findings applied so far
- portals-not-specs, oauth/webhook-endpoints-not-surfaces, explorer-pages-not-
  surfaces, mcp url = connect endpoint, http base url required, CLI-login setup
  text, no default creds (+ADC allowlist), spec live-validation with feedback,
  auth-gated (401/403/www-auth/405-graphql) accepted, dedup + specAlternates.

## Watchlist for morning review
- box.com: 3 separate OAuth creds that are arguably one app credential w/ fields
- cafe24: cred type taxonomy loose (client_id as oauth2_cc, secret as basic)
- batch-01 locatorless_http surfaces — re-run those domains if batch-02 shows
  the nudge works
- asana.com, kensho.com, ramp.com never completed (rate limits) — retry at high
  concurrency in the morning

## 03:50 update
- batch-01 ~92/200 done, 3 loop failures, checklist ~0-2 fails. Healthy.
- Prompt hardened twice mid-batch (base-url c74bb0d, dashboards-not-surfaces).
  Since batch-01 started BEFORE both fixes, built morning-rerun.txt (35 domains
  showing locatorless/dashboard symptoms) — rerun with --force at high
  concurrency after the TPM bump, alongside asana/kensho/ramp.
- algolia shows residual over-splitting (7 surfaces; 'website search index'
  should not be a surface) — acceptable rate for now, rerun list catches it.

## 04:30 update
- batch-01 at ~154/200, failures still 4. drive.sh chained to start batch-02
  when batch-01's process exits (concurrency 2, gates armed).
- checker refined twice more (negated 'do not use default credentials' text;
  {template} URLs and brand sibling-TLDs exempt from grounding).
- Capacity: median 129K tokens/domain, p90 248K. At the 200K TPM limit the
  remaining ~2,900 domains ≈ 32h — the morning TPM bump is the lever. When it
  lands: kill drive.sh, restart with concurrency 8-10 (resumable, skips done).
- No push notification sent: nothing user-actionable; everything proceeding.

## 06:40 update
- batch-02 mid-flight (~242 results overall), checklist 238/238 passing after
  two checker fixes (host-level grounding; negated default-cred text). Loop
  failures 5 total, all TPM — drive.sh sweep pass recovers them at the end.
- New deterministic guard: MCP urls that are auth/settings funnels demote to
  docs (featurebase case).
- Batch-02 output quality visibly better than batch-01 (locatorless http down
  from ~50% to ~6% of surfaces; no dashboard/console surfaces in new results).
- morning-rerun.txt at 39 domains (batch-01 vintage symptoms + featurebase).
- Driver is nohup-detached (pid survives session restarts); TPM-bump monitor
  armed. On bump: kill drive.sh, `bash scripts/batch/drive.sh <next-batch> 8`.

## 07:15 decision
- Quantified prompt delta: locatorless_http 47% of batch-01 surfaces vs 9% of
  batch-02. batch-01 (200 domains) gets a FULL rerun under the final prompt
  when TPM bumps (`run-loop --domains batches/batch-01.txt --force`), replacing
  the symptom-list approach (morning-rerun.txt now redundant for b1 domains;
  keep it for the results-mini sample vintage).
- check-results gained --probe (live-verify grounding offenders; github MCP
  endpoint case). 257/257 passing at last full check.

## Analytics event contract

Server events fire via `track()` in `worker/entry.ts` (PostHog capture API,
`distinct_id` = `cf-connecting-ip`, `$process_person_profile: false`). Client
events fire via `posthog-js` (`src/lib/analytics.ts`, first-party `/_i` proxy).
Every event also carries `user_agent`, `country`, and `path` on the server side.

### Server (worker)

| Event | Properties |
|-------|------------|
| `mcp_request` | `method?` (JSON-RPC method when parseable), `tool?` (tools/call name) |
| `discovery_run` | `domain`, `outcome` (`cached` \| `done`), `duration_ms`, `surfaces_count`, `credentials_count`, `used_llm` |
| `discovery_error` | `domain`, `message` (≤200 chars), `duration_ms` |
| `discovery_ratelimited` | `domain?` (SSE stream), `path?` (REST discover) |
| `api_request` | `endpoint?` (`detect` \| `discover` \| `openapi`), `cache_hit`, `status` |
| `data_fetch` | (base properties only) |
| `hit` | (base properties only; dual-sent to executor + integrations projects) |
| `og_render` | `kind` (`home` \| `domain` \| `surface`), `domain?`, `status`, `duration_ms`, `cache_hit` |
| `og_error` | `path`, `message` (≤200 chars) |
| `worker_exception` | `message` (≤200 chars), `stack` (first 300 chars) |

### Client (posthog-js)

| Event | Properties |
|-------|------------|
| `$pageview` | (PostHog default pageview) |
| `map_surface_clicked` | `domain` |
| `regenerate_clicked` | `domain` |
| `discovery_stream_done` | `domain`, `surfaces`, `duration_ms` |
| `discovery_stream_error` | `domain` |

### Health

`GET /healthz` — no auth, `Cache-Control: no-store`. Returns
`{ ok: true, version: <CACHE_VERSION>, kv?: "slow" }`. KV probe reads
`DISCOVERY.get("stripe.com")` with a 2s timeout; slow KV adds `kv: "slow"`
without failing the check (external uptime monitor target).

## 07:45 update — TPM bump landed (180M/min)
- Driver restarted at concurrency 16; ~560 domains done, batch 3 in flight.
- narvar rerun: correct empty result (no public dev surface). opentools.com is
  an MCP AGGREGATOR — its 'surfaces' are other vendors' servers; flagged for
  manual curation like apis.guru, checker fail is by design. Exclude or curate.
- Checker matured: placeholder hosts (YOUR_INSTANCE), localhost quickstarts,
  host-family grounding, cli-oauth check narrowed to login-acquired creds.
- Third-party-credential prompt rule active (narvar/opentools class).

## Launch readiness (2026-07-02 ~15:00) — COMPLETE
- Analytics: full outcome-carrying event set server+client, worker_exception
  catch-all, event contract documented above. Verify in PostHog after launch
  traffic arrives.
- /healthz live (version + KV probe) — point external uptime monitor here.
  ALERT DESTINATION still needs owner input.
- Launch P0s shipped: versioned data envelopes, www/workers.dev 301s,
  domain sitemap. OG 500s → 404s.
- Rate limit: 3 uncached discovery runs/IP/min, both endpoints.
- OPS RULE (from today's bad deploy): build+tests are NOT deploy verification.
  Mandatory: local `wrangler dev` smoke (healthz, one page, one data route)
  before every `wrangler deploy`. A rollback (`wrangler rollback`) took prod
  from 500s back to healthy in ~60s — total incident window ~4 minutes.
- Regen: ~1,300/3,124 on gpt-5.4; catalog swap after completion + checklist.
  Launch does NOT block on it (current data is live and checklist-clean).
