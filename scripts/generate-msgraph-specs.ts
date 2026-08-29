#!/usr/bin/env bun
/**
 * Mirrors the Microsoft Graph per-product OpenAPI slices into
 * public/specs/microsoft-graph/, as minified JSON with auth made explicit.
 *
 * The slices are built by executor's graph-slices workflow (the 43 MB Graph
 * monolith subset per product) and published as release assets. Two things
 * make a plain mirror insufficient:
 *
 * - The upstream YAML carries NO securitySchemes at all — a client adding a
 *   slice learns nothing about how to authenticate. Each mirrored document
 *   gets the Microsoft Entra OAuth scheme injected, with the product's
 *   delegated scopes (the same list the curated registry record carries).
 * - The upstream YAML is large enough (the catch-all slice is 428k lines)
 *   that line-count guards in whole-document parsers reject it. Minified
 *   JSON parses in one pass without those pathologies, and every OpenAPI
 *   client accepts JSON.
 *
 * Scopes come from executor's preset table, imported from a local checkout:
 *
 *   bun scripts/generate-msgraph-specs.ts --executor ../executor
 *
 * Output is committed: no cron, no build-time network. Re-run when executor
 * republishes the graph-slices release and commit the diff.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "specs", "microsoft-graph");
const RELEASE = "https://github.com/UsefulSoftwareCo/executor/releases/download/graph-slices";

const executorArg = process.argv.indexOf("--executor");
const EXECUTOR = resolve(
  ROOT,
  executorArg >= 0 ? (process.argv[executorArg + 1] ?? "") : "../../../executor",
);

const presets = (await import(
  join(EXECUTOR, "packages/plugins/openapi/src/providers/microsoft/presets.ts")
)) as {
  microsoftGraphScopePresets: readonly {
    id: string;
    name: string;
    scopes: readonly string[];
  }[];
  MICROSOFT_AUTHORIZATION_URL: string;
  MICROSOFT_TOKEN_URL: string;
  MICROSOFT_GRAPH_BASE_SCOPES: readonly string[];
  MICROSOFT_GRAPH_IDENTITY_SCOPE: string;
  MICROSOFT_GRAPH_DEFAULT_SCOPE: string;
};

/** The remainder bundle (everything no product slice claims). Mirrored with
 *  the broad delegated default scope, but not catalogued: 6,350 operations is
 *  not something anyone should add wholesale. */
const DEFAULT_SLICE = "default";

interface ManifestEntry {
  readonly bytes: number;
  readonly paths: number;
  readonly operations: number;
  readonly scopes: readonly string[];
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

async function mirrorSlice(id: string, name: string, scopes: readonly string[]): Promise<ManifestEntry> {
  const response = await fetch(`${RELEASE}/${id}.yaml`);
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  const spec = parseYaml(await response.text(), { maxAliasCount: -1 }) as {
    info?: Record<string, unknown>;
    components?: Record<string, unknown>;
    security?: unknown;
    paths?: Record<string, Record<string, unknown>>;
  };

  // Every slice titles itself "OData Service for namespace microsoft.graph";
  // clients name an added integration from info.title.
  spec.info = { ...spec.info, title: name };

  const delegatedScopes = [
    ...presets.MICROSOFT_GRAPH_BASE_SCOPES,
    presets.MICROSOFT_GRAPH_IDENTITY_SCOPE,
    ...scopes,
  ];
  const scopeMap = Object.fromEntries(delegatedScopes.map((scope) => [scope, ""]));
  spec.components = {
    ...spec.components,
    securitySchemes: {
      microsoftOAuth2: {
        type: "oauth2",
        description: "Microsoft Entra ID (delegated user consent).",
        flows: {
          authorizationCode: {
            authorizationUrl: presets.MICROSOFT_AUTHORIZATION_URL,
            tokenUrl: presets.MICROSOFT_TOKEN_URL,
            scopes: scopeMap,
          },
          clientCredentials: {
            tokenUrl: presets.MICROSOFT_TOKEN_URL,
            scopes: { [presets.MICROSOFT_GRAPH_DEFAULT_SCOPE]: "App-only access with admin consent." },
          },
        },
      },
    },
  };
  spec.security = [{ microsoftOAuth2: delegatedScopes }];

  const specText = JSON.stringify(spec);
  const paths = Object.keys(spec.paths ?? {});
  const operations = paths.reduce(
    (count, path) =>
      count +
      Object.keys(spec.paths?.[path] ?? {}).filter((method) => HTTP_METHODS.has(method)).length,
    0,
  );
  writeFileSync(join(OUT, `${id}.json`), specText);
  console.log(`${id}: ${paths.length} paths, ${operations} operations, ${(specText.length / 1e6).toFixed(1)} MB`);
  return { bytes: specText.length, paths: paths.length, operations, scopes: delegatedScopes };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const manifest: Record<string, ManifestEntry> = {};

  const slices: { id: string; name: string; scopes: readonly string[] }[] = [
    ...presets.microsoftGraphScopePresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      scopes: preset.scopes,
    })),
    { id: DEFAULT_SLICE, name: "Microsoft Graph", scopes: [presets.MICROSOFT_GRAPH_DEFAULT_SCOPE] },
  ];

  // Serial on purpose: each slice holds a parsed multi-MB document in memory.
  for (const slice of slices) {
    manifest[slice.id] = await mirrorSlice(slice.id, slice.name, slice.scopes);
  }

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: RELEASE, specs: manifest }, null, 2) +
      "\n",
  );
  console.log(`wrote ${Object.keys(manifest).length} specs to public/specs/microsoft-graph/`);
}

await main();
