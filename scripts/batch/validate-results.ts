import { existsSync } from "node:fs";
import { basename } from "node:path";
import { resolve } from "node:path";
import { getFlag, hasFlag, listJsonFiles, parseArgs, readJson, ROOT, usage } from "./shared.ts";
import { isSdkNotCli } from "../../src/lib/surface-classify.ts";
import type { AuthStatus, Credential, StoredDiscovery, Surface } from "../../src/lib/discovery-schema.ts";

/**
 * Post-run validation gate for batch discovery output.
 *
 * Checks the shape that actually ships: `results-full/{domain}.json`
 * (StoredDiscovery rows loaded straight into KV by load-kv.ts and rendered by
 * `src/pages/[domain]/[surface].astro`) and, optionally, the merged catalog
 * export (`sources/discovered.json`, produced by export-catalog.ts and
 * consumed by normalize.ts -> output/*.json -> the prerendered pages).
 *
 * This exists because a bad run can produce syntactically valid JSON that
 * still breaks the live site: an empty/derived-"undefined" slug renders as
 * literal `/domain/undefined/`, two surfaces can collide on the same
 * (domain, type, name) identity, required fields the templates dereference
 * unconditionally can be missing, and merging static registry data with
 * freshly discovered data can silently duplicate or shadow entries.
 *
 * Every check is additive (never mutates input) and reports ALL offenders it
 * finds, grouped by check, so a single run surfaces the full blast radius
 * instead of stopping at the first bad file.
 */

const HELP = `
Usage: bun scripts/batch/validate-results.ts [flags]

Flags:
  --results-dir dir     Directory of per-domain StoredDiscovery JSON files
                         (default: scripts/batch/results-full)
  --catalog file         Merged catalog export to also check
                         (default: sources/discovered.json; pass --no-catalog to skip)
  --no-catalog            Skip the merged-catalog checks
  --max-examples n       Examples to print per check before capping (default: 20)
  --help                 Show this help
`;

type Finding = { domain: string; detail: string };

class Report {
  private byCheck = new Map<string, Finding[]>();

  add(check: string, domain: string, detail: string): void {
    const list = this.byCheck.get(check) ?? [];
    list.push({ domain, detail });
    this.byCheck.set(check, list);
  }

  get failed(): boolean {
    return [...this.byCheck.values()].some((list) => list.length > 0);
  }

  print(maxExamples: number): void {
    const checks = [...this.byCheck.entries()].filter(([, list]) => list.length > 0);
    if (checks.length === 0) {
      console.log("validate-results: all checks passed");
      return;
    }
    console.log(`validate-results: ${checks.length} check(s) failed\n`);
    for (const [check, findings] of checks) {
      console.log(`✗ ${check} (${findings.length} offender${findings.length === 1 ? "" : "s"})`);
      for (const f of findings.slice(0, maxExamples)) {
        console.log(`    ${f.domain}${f.detail ? `  ${f.detail}` : ""}`);
      }
      if (findings.length > maxExamples) {
        console.log(`    ... and ${findings.length - maxExamples} more`);
      }
      console.log("");
    }
    const total = checks.reduce((n, [, list]) => n + list.length, 0);
    console.log(`total offenders across ${checks.length} check(s): ${total}`);
  }
}

// ── slug / URL-segment sanity ──────────────────────────────────────────────

const BAD_SEGMENT = new Set(["undefined", "null", "nan", "[object object]"]);

/** True when a value, once used as a URL path segment the way the site
 * builds surface links (`/${domain}/${slug}/`), would render a garbage
 * segment: empty, or the literal string an unset JS variable stringifies to. */
function isBadPathSegment(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return BAD_SEGMENT.has(trimmed.toLowerCase());
}

// ── required-field policy, derived from src/pages/[domain]/[surface].astro
// and src/lib/discovery-schema.ts (surfaceBase + per-type fields) ──────────

/** Fields the surface detail page (`[surface].astro`) dereferences
 * unconditionally, or that are the sole locator for a surface type — missing
 * them either breaks rendering or ships a dead entry (a title with nothing
 * underneath it). */
function requiredFieldFindings(domain: string, surface: Surface, report: Report): void {
  if (isBadPathSegment(surface.slug)) {
    report.add("badSlug", domain, `type=${surface.type} name=${JSON.stringify(surface.name)} slug=${JSON.stringify(surface.slug)}`);
  }
  if (typeof surface.name !== "string" || surface.name.trim().length === 0) {
    report.add("missingName", domain, `type=${surface.type} slug=${JSON.stringify(surface.slug)}`);
  }
  if (!surface.auth || typeof surface.auth.status !== "string") {
    report.add("missingAuthStatus", domain, `type=${surface.type} name=${JSON.stringify(surface.name)}`);
  }

  // Every surface needs SOME locator the detail page can render as its
  // primary "Endpoint"/"URL"/"Command" row.
  const hasUrl = "url" in surface && typeof surface.url === "string" && surface.url.trim().length > 0;
  const hasSpec = "spec" in surface && typeof surface.spec === "string" && surface.spec.trim().length > 0;
  const hasCommand = "command" in surface && typeof surface.command === "string" && surface.command.trim().length > 0;
  const hasPackages = "packages" in surface && Array.isArray(surface.packages) && surface.packages.length > 0;

  if ((surface.type === "http" || surface.type === "graphql") && !hasUrl && !hasSpec) {
    report.add("missingLocator", domain, `type=${surface.type} name=${JSON.stringify(surface.name)} (needs url or spec)`);
  } else if (surface.type === "mcp" && !hasUrl) {
    report.add("missingLocator", domain, `type=mcp name=${JSON.stringify(surface.name)} (needs url)`);
  } else if (surface.type === "cli" && !hasCommand && !hasPackages) {
    report.add("missingLocator", domain, `type=cli name=${JSON.stringify(surface.name)} (needs command or packages)`);
  }

  // Required auth: the detail page renders one card per AuthEntry — an entry
  // with an empty `use[]`, or `status: required` with zero entries, is
  // invisible (no card rendered for a surface that claims auth is required).
  if (surface.auth?.status === "required") {
    if (!Array.isArray(surface.auth.entries) || surface.auth.entries.length === 0) {
      report.add("emptyRequiredAuth", domain, `type=${surface.type} name=${JSON.stringify(surface.name)} (status=required but no entries)`);
    } else {
      for (const entry of surface.auth.entries) {
        if (!Array.isArray(entry.use) || entry.use.length === 0) {
          report.add("emptyRequiredAuth", domain, `type=${surface.type} name=${JSON.stringify(surface.name)} (an auth entry has an empty use[])`);
        }
      }
    }
  }
}

function collectAuthCredentialIds(auth: AuthStatus, out: Set<string>): void {
  if (auth.status !== "required") return;
  for (const entry of auth.entries) {
    for (const use of entry.use) out.add(use.id);
  }
}

function credentialFindings(domain: string, credentials: Record<string, Credential>, referencedIds: Set<string>, report: Report): void {
  for (const [id, cred] of Object.entries(credentials)) {
    if (!cred.label || cred.label.trim().length === 0) {
      report.add("missingCredentialField", domain, `credential=${id} missing label`);
    }
    if (!cred.setup || cred.setup.trim().length === 0) {
      report.add("missingCredentialField", domain, `credential=${id} missing setup (auth instructions)`);
    }
  }
  // A surface's auth references a credential id that isn't in the registry —
  // the detail page silently drops that card's label/type/setup content.
  for (const id of referencedIds) {
    if (!(id in credentials)) {
      report.add("danglingCredentialRef", domain, `credential id ${JSON.stringify(id)} referenced by a surface but not defined`);
    }
  }
}

// ── duplicate (domain, surface-type, name) detection ────────────────────────

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The one field that identifies WHERE a surface points, regardless of type. */
function surfaceLocator(surface: Surface): string | undefined {
  if (surface.type === "cli") return surface.command;
  if ("spec" in surface && surface.spec) return surface.spec;
  return "url" in surface ? surface.url : undefined;
}

/** Within one domain's result, flag surfaces that collide on (type, name) —
 * the exact shape of the reported "Datadog listed twice" bug: two surfaces
 * of the same kind with the same display name is either a dedup-pass miss or
 * a genuine duplicate the site will render twice. */
function withinDomainDuplicates(domain: string, surfaces: readonly Surface[], report: Report): void {
  const seen = new Map<string, Surface>();
  for (const surface of surfaces) {
    if (isSdkNotCli(surface)) continue; // filtered from render paths; not a real dupe risk
    const key = `${surface.type}|${normName(surface.name)}`;
    const prior = seen.get(key);
    if (prior) {
      report.add(
        "duplicateSurface",
        domain,
        `type=${surface.type} name=${JSON.stringify(surface.name)} appears more than once (slugs: ${prior.slug}, ${surface.slug})`,
      );
    } else {
      seen.set(key, surface);
    }
  }

  // Same locator (url/spec/command), different name — e.g. "Stripe CLI" and
  // "Stripe MCP" both pointing at the same command/endpoint with mismatched
  // labels is the reported Stripe CLI/MCP dupe shape when the locator is
  // actually identical (as opposed to two genuinely distinct surfaces).
  const byLocator = new Map<string, Surface>();
  for (const surface of surfaces) {
    if (isSdkNotCli(surface)) continue;
    const locator = surfaceLocator(surface);
    if (!locator) continue;
    const key = `${surface.type}|${locator.trim().toLowerCase()}`;
    const prior = byLocator.get(key);
    if (prior && normName(prior.name) !== normName(surface.name)) {
      report.add(
        "mismatchedDuplicateLocator",
        domain,
        `type=${surface.type} locator=${JSON.stringify(locator)} has two different names: ${JSON.stringify(prior.name)} vs ${JSON.stringify(surface.name)}`,
      );
    } else if (!prior) {
      byLocator.set(key, surface);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const resultsDir = resolve(ROOT, getFlag(args, "results-dir", "scripts/batch/results-full")!);
  const maxExamples = Number(getFlag(args, "max-examples", "20")) || 20;
  const checkCatalog = !hasFlag(args, "no-catalog");
  const catalogPath = resolve(ROOT, getFlag(args, "catalog", "sources/discovered.json")!);

  const report = new Report();

  // ── per-domain results (results-full/ or whatever --results-dir points at) ──
  const files = listJsonFiles(resultsDir);
  if (files.length === 0) {
    console.error(`validate-results: no result JSON files found in ${resultsDir}`);
    process.exit(1);
  }

  // Cross-domain identity: (domain, type, name) collisions across the WHOLE
  // results set — catches things like the same domain's discovery being
  // written under two different filenames, or a batch re-run producing a
  // second file for a domain that was renamed/aliased.
  const globalSeen = new Map<string, string>(); // key -> first file that had it

  for (const file of files) {
    const domain = basename(file, ".json");
    let row: StoredDiscovery;
    try {
      row = readJson<StoredDiscovery>(file);
    } catch (err) {
      report.add("invalidJson", domain, `${file}: ${(err as Error).message}`);
      continue;
    }
    const result = row.result;
    if (!result) {
      report.add("missingResult", domain, `${file} has no result`);
      continue;
    }
    if (isBadPathSegment(result.domain)) {
      report.add("badDomain", domain, `result.domain=${JSON.stringify(result.domain)} (file ${basename(file)})`);
    }
    if (!result.summary || result.summary.trim().length === 0) {
      report.add("missingSummary", domain, "result.summary is empty");
    }

    const surfaces = result.surfaces ?? [];
    const referencedCredIds = new Set<string>();
    for (const surface of surfaces) {
      requiredFieldFindings(domain, surface, report);
      collectAuthCredentialIds(surface.auth, referencedCredIds);

      const globalKey = `${surface.type}|${normName(surface.name ?? "")}|${(surfaceLocator(surface) ?? "").trim().toLowerCase()}`;
      const priorFile = globalSeen.get(globalKey);
      if (priorFile && priorFile !== file) {
        report.add(
          "duplicateAcrossDomains",
          domain,
          `type=${surface.type} name=${JSON.stringify(surface.name)} also appears in ${basename(priorFile)}`,
        );
      } else if (!priorFile) {
        globalSeen.set(globalKey, file);
      }
    }
    credentialFindings(domain, result.credentials ?? {}, referencedCredIds, report);
    withinDomainDuplicates(domain, surfaces, report);
  }

  // ── merged catalog export (sources/discovered.json) ──────────────────────
  // This is where static-source + discovered-data merge bugs live: the same
  // domain appearing from two sources with different surface sets, or a
  // record whose fields were flattened/renamed on the way out losing the
  // slug/name guarantees the per-domain results had.
  if (checkCatalog) {
    if (!existsSync(catalogPath)) {
      console.log(`validate-results: catalog file not found at ${catalogPath}, skipping catalog checks`);
    } else {
      type CatalogSurface = { slug?: unknown; name?: unknown; type?: unknown; url?: unknown; spec?: unknown; command?: unknown; authStatus?: unknown };
      type CatalogDomain = { domain?: unknown; summary?: unknown; surfaces?: CatalogSurface[] };
      const catalog = readJson<{ domains?: CatalogDomain[] }>(catalogPath);
      const domainCounts = new Map<string, number>();
      for (const d of catalog.domains ?? []) {
        const domain = typeof d.domain === "string" ? d.domain : "(missing domain)";
        domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);

        if (isBadPathSegment(d.domain)) {
          report.add("catalogBadDomain", domain, `domain=${JSON.stringify(d.domain)}`);
        }
        const seenInDomain = new Map<string, CatalogSurface>();
        for (const s of d.surfaces ?? []) {
          if (isBadPathSegment(s.slug)) {
            report.add("catalogBadSlug", domain, `type=${String(s.type)} name=${JSON.stringify(s.name)} slug=${JSON.stringify(s.slug)}`);
          }
          if (typeof s.name !== "string" || s.name.trim().length === 0) {
            report.add("catalogMissingName", domain, `type=${String(s.type)} slug=${JSON.stringify(s.slug)}`);
          }
          const type = typeof s.type === "string" ? s.type : "unknown";
          const hasUrl = typeof s.url === "string" && s.url.trim().length > 0;
          const hasSpec = typeof s.spec === "string" && s.spec.trim().length > 0;
          const hasCommand = typeof s.command === "string" && s.command.trim().length > 0;
          if ((type === "http" || type === "openapi" || type === "graphql") && !hasUrl && !hasSpec) {
            report.add("catalogMissingLocator", domain, `type=${type} name=${JSON.stringify(s.name)} (needs url or spec)`);
          } else if (type === "mcp" && !hasUrl) {
            report.add("catalogMissingLocator", domain, `type=mcp name=${JSON.stringify(s.name)} (needs url)`);
          } else if (type === "cli" && !hasCommand) {
            report.add("catalogMissingLocator", domain, `type=cli name=${JSON.stringify(s.name)} (needs command)`);
          }

          const key = `${type}|${normName(typeof s.name === "string" ? s.name : "")}`;
          const prior = seenInDomain.get(key);
          if (prior) {
            report.add("catalogDuplicateSurface", domain, `type=${type} name=${JSON.stringify(s.name)} appears more than once (slugs: ${String(prior.slug)}, ${String(s.slug)})`);
          } else {
            seenInDomain.set(key, s);
          }
        }
      }
      for (const [domain, count] of domainCounts) {
        if (count > 1) report.add("catalogDuplicateDomain", domain, `domain appears ${count} times in ${basename(catalogPath)} (static + discovered merge collision)`);
      }
    }
  }

  report.print(maxExamples);
  if (report.failed) process.exit(1);
}

await main();
