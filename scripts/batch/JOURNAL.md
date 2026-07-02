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
