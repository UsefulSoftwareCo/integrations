# Composing Google products without duplicating sign-ins

Draft proposal for [#102](https://github.com/UsefulSoftwareCo/integrations/issues/102).
The intended consumer is an app that combines several Google products while
keeping one connection requirement per Google identity. This document adds no
schema, generated specifications, provider policy or account changes.

## Use the existing catalog contract

[`curated/google.json`](../curated/google.json) already groups per-product
interfaces and records their endpoint, specification and OAuth scopes. A consumer
can select those interfaces, preserve their operation definitions, and collect
the declared scopes without inventing another composition record.

The app should bind supported OAuth products to the same selected Google account,
keeping product tool namespaces and native approval behavior. Multiple Google
identities remain separate. Preserve original product instructions when composing
them; an Ads tool's manager-account requirements, for example, should not disappear
because its sign-in is shared.

Catalog scopes describe requested access. They do not establish which scopes a
hosted OAuth client may request, what a particular account granted, or whether an
API is enabled. Those are separate checks owned by the consumer and provider.

## Authentication boundaries

| Input or condition | What composition should do |
| --- | --- |
| Several OAuth products supported by the same client | Deduplicate their declared scope union and use one account requirement |
| A scope outside that client's supported set | Report the unsupported capability; do not silently broaden the client's policy |
| A changed provider definition or insufficient existing grant | Preserve the old account and request the required new consent explicitly |
| API key, service account, delegation, Workspace role or billing requirement | Keep that prerequisite explicit; it is not satisfied by generic Google OAuth |

Credential placement remains the app's explicit responsibility. A catalog import
must not silently trust additional hosts or authorize additional operations.
Separate product entries should remain usable independently.

## Exercised app composition

A private installed copy of the Executor Google app retains its original product
tools and adds Apps Script, BigQuery, Search Console, Ads and YouTube through the
same `google` requirement. It reuses original schemas and metadata instead of
duplicating each product's tool implementation.

The candidate passed strict TypeScript compilation, 80 focused synthetic tests
with 917 assertions, and an SDK account-binding check. Live read-only checks
passed 22 of 24 calls across four reauthorized accounts. Ads customer discovery
returned HTTP 401 for two; its cause remains unresolved. These results do not
prove every tool, write operation or GOG command works, and they are not tests of
a runtime change in this documentation-only proposal.

## Ownership and next step

The catalog's generated Google specs come from
[`scripts/generate-google-specs.ts`](../scripts/generate-google-specs.ts), which
imports Executor's presets and Discovery converter. Preserve that generation
boundary when a genuine coverage gap needs a later change. This proposal does
not edit generated JSON or alter per-operation accepted scopes; that is separate
from the work in [#85](https://github.com/UsefulSoftwareCo/integrations/pull/85)
and [#86](https://github.com/UsefulSoftwareCo/integrations/pull/86).

Executor's public `v2` infrastructure identifies a separate `executor-apps`
repository as the publisher of its official app feed. That repository was not
accessible through the contributor's account. The app-source integration target
therefore needs maintainer confirmation; catalog documentation cannot install
the tested composition into the official app.

The requested decision is whether this existing catalog contract is sufficient
for composition and where to contribute the app delta. Any later schema addition
should address a demonstrated missing prerequisite rather than duplicate the
interfaces and scopes already present. Host-side discussion is in
[executor#2492](https://github.com/UsefulSoftwareCo/executor/issues/2492).
