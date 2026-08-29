#!/usr/bin/env bun
/**
 * Generates self-contained OpenAPI documents for Google services from their
 * Discovery documents, into public/specs/google/.
 *
 * Google does not publish OpenAPI; it publishes Discovery documents, and the
 * third-party conversions (apis.guru) are what gave the catalog rows like
 * "Gmailpostmastertools". This script runs executor's own Discovery→OpenAPI
 * converter — the exact pipeline the product executes at add time — so the
 * hosted spec is byte-identical to what a client would have derived, minus the
 * per-request work.
 *
 * The converter is not part of the published @executor-js/plugin-openapi
 * package, so it is imported from a local executor checkout, along with the
 * preset table that names the services and their consent scopes:
 *
 *   bun scripts/generate-google-specs.ts --executor ../executor
 *
 * Output is committed, like the Microsoft Graph slices: no cron, no build-time
 * network. Re-run when Google revs a service and commit the diff.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "specs", "google");

const executorArg = process.argv.indexOf("--executor");
const EXECUTOR = resolve(
  ROOT,
  executorArg >= 0 ? (process.argv[executorArg + 1] ?? "") : "../../../executor",
);

const providerDir = join(EXECUTOR, "packages/plugins/openapi/src/providers/google");
const { googleOpenApiPresets, googleCatalogOAuthScopesForPreset } = await import(
  join(providerDir, "presets.ts")
);
const { convertGoogleDiscoveryBundleToOpenApi, normalizeGoogleDiscoveryUrl } = await import(
  join(providerDir, "discovery.ts")
);
// The converter returns executor-flavored Effects; run them with executor's
// own effect instance so the runtime identities match.
const { Effect } = await import(join(EXECUTOR, "node_modules/effect/dist/index.js"));

interface ManifestEntry {
  readonly bytes: number;
  readonly title: string;
  readonly service: string;
  readonly version: string;
  readonly paths: number;
  readonly operations: number;
  readonly discoveryUrls: readonly string[];
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const manifest: Record<string, ManifestEntry> = {};

  for (const preset of googleOpenApiPresets as readonly {
    id: string;
    name: string;
    urls?: readonly string[] | string;
    url?: string;
  }[]) {
    const urls = [preset.urls ?? preset.url ?? []].flat();
    if (urls.length === 0) {
      console.error(`${preset.id}: no discovery URL, skipping`);
      continue;
    }

    const documents = await Promise.all(
      urls.map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${preset.id}: ${url} → HTTP ${response.status}`);
        return {
          discoveryUrl: normalizeGoogleDiscoveryUrl(url) ?? url,
          documentText: await response.text(),
        };
      }),
    );

    // The security scheme lists the scopes the product actually requests —
    // the same list the curated registry record carries — rather than every
    // scope the Discovery document mentions.
    const conversion = await Effect.runPromise(
      convertGoogleDiscoveryBundleToOpenApi({
        documents,
        consentScopes: googleCatalogOAuthScopesForPreset(preset.id),
      }),
    );

    const spec = JSON.parse(conversion.specText) as {
      info?: Record<string, unknown>;
      paths?: Record<string, Record<string, unknown>>;
    };
    // The bundle converter titles everything "Google"; a hosted standalone
    // document should carry the service's own identity, since clients name an
    // added integration from info.title.
    const discovery = JSON.parse(documents[0]!.documentText) as {
      title?: string;
      version?: string;
      description?: string;
    };
    spec.info = {
      ...spec.info,
      title: discovery.title ?? preset.name,
      version: discovery.version ?? "v1",
      ...(discovery.description ? { description: discovery.description } : {}),
    };
    const specText = JSON.stringify(spec);
    const paths = Object.keys(spec.paths ?? {});
    const operations = paths.reduce(
      (count, path) =>
        count +
        Object.keys(spec.paths?.[path] ?? {}).filter((method) => HTTP_METHODS.has(method)).length,
      0,
    );

    if (operations === 0) {
      // Keep, for example: enterprise-only, and executor's service policy
      // strips every method. A spec with no operations helps nobody.
      console.error(`${preset.id}: 0 operations after policy filtering, skipping`);
      continue;
    }

    const file = `${preset.id}.json`;
    writeFileSync(join(OUT, file), specText);
    manifest[preset.id] = {
      bytes: specText.length,
      title: discovery.title ?? preset.name,
      service: conversion.service ?? preset.id,
      version: discovery.version ?? "v1",
      paths: paths.length,
      operations,
      discoveryUrls: urls,
    };
    console.log(
      `${preset.id}: ${paths.length} paths, ${operations} operations, ${(specText.length / 1e6).toFixed(2)} MB`,
    );
  }

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), specs: manifest }, null, 2) + "\n",
  );
  console.log(`wrote ${Object.keys(manifest).length} specs to public/specs/google/`);
}

await main();
