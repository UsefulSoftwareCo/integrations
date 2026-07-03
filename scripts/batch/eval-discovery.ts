import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_JSON_SCHEMA, SYSTEM, buildUserMessage } from "./discovery-prompt.ts";
import { displaySize, envValue, getFlag, hasFlag, parseArgs, readJson, registrable, ROOT, safeDomainFile, usage, validateAndFinalize, writeJson } from "./shared.ts";
import { surfaceDedupKey } from "./dedup.ts";

const HELP = `
Usage: bun scripts/batch/eval-discovery.ts --domains a.com,b.com [flags]

Flags:
  --model name       OpenAI model (default: gpt-5.4)
  --corpus dir       Corpus dir (default: scripts/batch/corpus)
  --out dir          Eval output dir (default: scripts/batch/eval-out)
  --help             Show this help
`;

type PromptModule = {
  SYSTEM: string;
  buildUserMessage(domain: string, corpus: unknown, detect?: unknown): string;
  DISCOVERY_JSON_SCHEMA: object;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

export type Checklist = {
  passed: boolean;
  checks: Record<string, { passed: boolean; offenders?: string[] }>;
};

const INPUT_PER_M = 2.5;
const OUTPUT_PER_M = 15;

function loadCorpus(corpusDir: string, domain: string): { pages: unknown[]; detect?: unknown; text: string } {
  const path = join(corpusDir, `${safeDomainFile(domain)}.json`);
  if (!existsSync(path)) throw new Error(`missing corpus for ${domain}: ${path}`);
  const corpus = readJson<{ pages?: unknown[]; detect?: unknown }>(path);
  return { pages: Array.isArray(corpus.pages) ? corpus.pages : [], detect: corpus.detect, text: JSON.stringify(corpus) };
}

function buildMessages(domain: string, corpus: { pages: unknown[]; detect?: unknown }, prompt: PromptModule): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: prompt.SYSTEM },
    { role: "user", content: prompt.buildUserMessage(domain, corpus.pages, corpus.detect) },
  ];
}

async function chat(apiKey: string, model: string, messages: Array<{ role: "system" | "user"; content: string }>): Promise<ChatResponse> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_schema", json_schema: DISCOVERY_JSON_SCHEMA },
      max_completion_tokens: 16_000,
    }),
  });
  const body = (await res.json()) as ChatResponse;
  if (!res.ok) throw new Error(body.error?.message ?? `chat completion failed: ${res.status}`);
  return body;
}

function collectUrls(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.match(/https?:\/\/[^\s"'<>),\]`]+/g) ?? []) {
      if (/^https?:\/\/\.{2,}/.test(match)) continue; // literal "http://..." ellipses in prose
      out.add(match.replace(/[.;,]+$/, ""));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, out);
  }
  return out;
}

function collectEvidenceUrls(result: { surfaces?: readonly unknown[] }): Set<string> {
  const out = new Set<string>();
  const collectBasis = (basis: unknown) => {
    const evidence = basis && typeof basis === "object" ? (basis as { evidence?: unknown }).evidence : undefined;
    if (Array.isArray(evidence)) for (const item of evidence) if (typeof item === "string") collectUrls(item, out);
  };
  for (const surface of result.surfaces ?? []) {
    if (!surface || typeof surface !== "object") continue;
    collectBasis((surface as { basis?: unknown }).basis);
    const auth = (surface as { auth?: { basis?: unknown; entries?: unknown[] } }).auth;
    collectBasis(auth?.basis);
    for (const entry of auth?.entries ?? []) {
      if (entry && typeof entry === "object") collectBasis((entry as { basis?: unknown }).basis);
    }
  }
  return out;
}

function credentialsOf(result: { credentials?: unknown }): Record<string, unknown> {
  return result.credentials && typeof result.credentials === "object" && !Array.isArray(result.credentials)
    ? (result.credentials as Record<string, unknown>)
    : {};
}

function authUses(result: { surfaces?: readonly unknown[] }): Array<{ id?: string; mechanics?: { source?: string } }> {
  const out: Array<{ id?: string; mechanics?: { source?: string } }> = [];
  for (const surface of result.surfaces ?? []) {
    const auth = surface && typeof surface === "object" ? (surface as { auth?: { entries?: unknown[] } }).auth : undefined;
    for (const entry of auth?.entries ?? []) {
      const use = entry && typeof entry === "object" ? (entry as { use?: unknown[] }).use : undefined;
      for (const item of use ?? []) if (item && typeof item === "object") out.push(item as { id?: string; mechanics?: { source?: string } });
    }
  }
  return out;
}

function specPointers(surface: unknown): string[] {
  if (!surface || typeof surface !== "object") return [];
  const { spec, specAlternates } = surface as { spec?: unknown; specAlternates?: unknown };
  return [
    ...(typeof spec === "string" ? [spec] : []),
    ...(Array.isArray(specAlternates) ? specAlternates.filter((item): item is string => typeof item === "string") : []),
  ];
}

export function checklist(
  result: { domain?: string; detect?: unknown; credentials?: unknown; surfaces?: readonly unknown[] },
  corpusText?: string,
  visited?: readonly string[],
  grounding?: readonly string[],
): Checklist {
  const credentials = credentialsOf(result);
  const credentialEntries = Object.entries(credentials);
  // Flag only concrete shared-login VALUES (admin/admin tuples, factory
  // defaults) — prose legitimately says 'default credentials' for the default
  // auth method, ADC, or when warning against shared logins.
  const defaultCredentialRegex = /factory[- ]default|default (login|password) is\b|\badmin\s*\/\s*(admin|edit|password)\b|`admin`\s*\/\s*`/i;
  const defaultCredentialOffenders = credentialEntries
    .filter(([, credential]) => {
      const setup = credential && typeof credential === "object" ? (credential as { setup?: unknown }).setup : undefined;
      return typeof setup === "string" && defaultCredentialRegex.test(setup);
    })
    .map(([id]) => id);
  const evidenceUrls = collectEvidenceUrls(result);
  const resultDomain = typeof result.domain === "string" ? registrable(result.domain) : null;
  const detectedUrls = collectUrls(result.detect);
  // Hosts the loop actually visited are grounded too — a service's docs often
  // live on a sibling registrable domain (canva.com → canva.dev).
  const visitedDomains = new Set((visited ?? []).map((url) => registrable(url)).filter(Boolean));
  const groundingSet = new Set(
    (grounding ?? []).flatMap((url) => {
      const clean = url.replace(/[.,;:]+$/, "");
      // URLs embedded in query params (auth.x.com/authorize?audience=https://api.y.com) ground too.
      let decoded = clean;
      try { decoded = decodeURIComponent(clean); } catch { /* malformed % sequences stay raw */ }
      // A greedy match swallows embedded URLs — start a match at EVERY scheme occurrence.
      const embedded: string[] = [];
      for (let i = decoded.indexOf("http", 1); i !== -1; i = decoded.indexOf("http", i + 1)) {
        const m = /^https?:\/\/[^\s"'<>),&\]`]+/.exec(decoded.slice(i));
        if (m) embedded.push(m[0]);
      }
      return [clean, ...embedded];
    }),
  );
  // A HOST the loop read (in any URL) grounds other paths on that host — the
  // model saying management.filestackapi.com is fine when the docs showed
  // management.filestackapi.com/apps.
  const groundedHosts = new Set([...groundingSet].map((url) => { try { return new URL(url).host; } catch { return ""; } }).filter(Boolean));
  const groundedRegDomains = new Set([...groundedHosts].map((host) => registrable(`https://${host}`)).filter(Boolean));
  // The brand's own sibling TLDs count as home turf (clickhouse.com ↔
  // clickhouse.cloud); template URLs ({yourDomain}/…) are placeholders, not claims.
  const brandLabel = resultDomain ? resultDomain.split(".")[0] : null;
  const urlOffenders = [...collectUrls(result)].filter((url) => {
    if (corpusText !== undefined) return !corpusText.includes(url);
    if (/[{}*]/.test(url) || /\/\/[^/]*\b[A-Z]{2,}[A-Z_-]*[A-Z]\b/.test(url)) return false; // {tenant}, *.wildcard, YOUR_INSTANCE placeholders
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/.test(url)) return false; // self-hosted quickstart examples
    if (/\.(example|test|invalid|localhost)([:/]|$)|(^|\.)(example|your-?[a-z-]+)\.(com|org|net|example)([:/]|$)/.test(url)) return false; // RFC 2606 + your-instance placeholders
    const urlDomain = registrable(url);
    return (
      !evidenceUrls.has(url) &&
      !(resultDomain && urlDomain === resultDomain) &&
      !(brandLabel && urlDomain && urlDomain.split(".")[0] === brandLabel) &&
      !detectedUrls.has(url) &&
      !(urlDomain && visitedDomains.has(urlDomain)) &&
      !groundingSet.has(url.replace(/[.,;:]+$/, "")) &&
      !(() => { try { return groundedHosts.has(new URL(url).host); } catch { return false; } })() &&
      !(urlDomain && groundedRegDomains.has(urlDomain))
    );
  });
  const unresolvedAuthIds = authUses(result)
    .map((use) => use.id)
    .filter((id): id is string => typeof id === "string" && !(id in credentials));
  const cliOauthOffenders = authUses(result)
    .filter((use) => {
      const credential = typeof use.id === "string" ? credentials[use.id] : undefined;
      const setup = credential && typeof credential === "object" ? (credential as { setup?: unknown }).setup : undefined;
      // Only creds ACQUIRED by a login command; env-var/flag consumption via
      // cli mechanics may legitimately document the service's OAuth endpoints.
      const mech = use.mechanics as { source?: string; command?: string; env?: string[] } | undefined;
      const acquiredByCli = mech?.source === "cli" && !!mech.command && !/[<{$]/.test(mech.command) && !mech.env?.length;
      // Only when the CLI is the WHOLE acquisition story: setup that walks a
      // dashboard/app-creation path legitimately cites OAuth endpoints.
      const cliIsWholeStory = typeof setup === "string" && /\brun\b[^.]*`[^`]*login/i.test(setup) && !/dashboard|console|applications tab|create an? (oauth )?(app|application|client)/i.test(setup);
      return acquiredByCli && cliIsWholeStory && typeof use.id === "string" && typeof setup === "string" && /\/oauth\//i.test(setup);
    })
    .map((use) => use.id!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
  // http only: graphql spec pointers are live-validated in the loop (SDL URLs
  // and auth-gated endpoints legitimately fail this URL-shape heuristic).
  const specOffenders = (result.surfaces ?? [])
    .filter((surface) => (surface as { type?: string })?.type === "http")
    .flatMap(specPointers)
    .filter((spec): spec is string => typeof spec === "string" && spec !== "introspection")
    .filter((spec) => !/\.(json|ya?ml)(?:[?#].*)?$/i.test(spec) && !/openapi|swagger|\/api\/schema\/?|\/api-docs(\/|$)/i.test(spec));
  const seenKeys = new Set<string>();
  const duplicateKeys: string[] = [];
  for (const surface of result.surfaces ?? []) {
    // Same qualification the dedup collision pass applies: distinct docs on a
    // shared spec = distinct product APIs (edmunds), not duplicates.
    const s = surface as { spec?: unknown; docs?: unknown };
    const docsQualifier = typeof s.spec === "string" && typeof s.docs === "string" ? `|${s.docs.toLowerCase()}` : "";
    const key = surfaceDedupKey(surface as Record<string, unknown>) + docsQualifier;
    if (seenKeys.has(key)) duplicateKeys.push(key);
    seenKeys.add(key);
  }
  const requiredEmpty = (result.surfaces ?? [])
    .filter((surface) => {
      const auth = surface && typeof surface === "object" ? (surface as { auth?: { status?: string; entries?: unknown[] }; name?: unknown }).auth : undefined;
      return auth?.status === "required" && (!Array.isArray(auth.entries) || auth.entries.length === 0);
    })
    .map((surface) => String((surface as { name?: unknown }).name ?? "surface"));
  // Drift: a result whose surfaces all point at ONE other company's domain
  // (and never at the subject) mapped the wrong company.
  const surfaceDomains = new Set(
    (result.surfaces ?? [])
      .flatMap((surface) => {
        if (!surface || typeof surface !== "object") return [];
        const { url, spec, docs } = surface as { url?: unknown; spec?: unknown; docs?: unknown };
        return [url, spec, docs].filter((value): value is string => typeof value === "string");
      })
      .map((url) => registrable(url))
      .filter(Boolean),
  );
  // Rebrands/acquisitions mention the subject somewhere (summaries say
  // "formerly Twitter", names carry the brand); true drift never does —
  // producthunt's result mentions Buffer everywhere and the subject only in
  // the domain/detect fields and a ?ref= param.
  const { domain: _d, detect: _det, ...body } = result as Record<string, unknown>;
  const bodyText = JSON.stringify(body).toLowerCase().replace(/[?&]ref=[a-z0-9_-]+/g, "");
  const drifted =
    (result.surfaces ?? []).length > 0 &&
    resultDomain !== null &&
    !surfaceDomains.has(resultDomain) &&
    surfaceDomains.size === 1 &&
    !(brandLabel && brandLabel.length >= 2 && bodyText.includes(brandLabel));
  const checks = {
    noDefaultCredentialSetup: { passed: defaultCredentialOffenders.length === 0, offenders: defaultCredentialOffenders },
    outputUrlsGrounded: { passed: urlOffenders.length === 0, offenders: urlOffenders },
    authUseIdsResolve: { passed: unresolvedAuthIds.length === 0, offenders: [...new Set(unresolvedAuthIds)] },
    cliMechanicsSetupHasNoOauthPath: { passed: cliOauthOffenders.length === 0, offenders: cliOauthOffenders },
    specUrlsLookMachineReadable: { passed: specOffenders.length === 0, offenders: specOffenders },
    noDuplicateSurfaceKeys: { passed: duplicateKeys.length === 0, offenders: duplicateKeys },
    // Advisory: needs human judgment (hard rebrands like twitter→x look
    // identical to true drift). Reported but never fails the checklist.
    noDomainDrift: { passed: true, offenders: drifted ? [...surfaceDomains] : [] },
    noRequiredAuthWithEmptyEntries: { passed: requiredEmpty.length === 0, offenders: requiredEmpty },
  };
  return { passed: Object.values(checks).every((check) => check.passed), checks };
}

function cost(usage: ChatResponse["usage"]): number {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return (input / 1_000_000) * INPUT_PER_M + (output / 1_000_000) * OUTPUT_PER_M;
}

async function evaluateDomain(domain: string, model: string, corpusDir: string, outDir: string, apiKey: string): Promise<{ domain: string; passed: boolean; cost: number; usage?: ChatResponse["usage"] }> {
  const corpus = loadCorpus(corpusDir, domain);
  const messages = buildMessages(domain, corpus, { SYSTEM, buildUserMessage, DISCOVERY_JSON_SCHEMA });
  const response = await chat(apiKey, model, messages);
  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${domain}: missing model content`);
  const parsed = JSON.parse(content) as unknown;
  const { result, collapses } = validateAndFinalize(domain, parsed);
  for (const item of collapses) console.log(`dedup: ${item.domain} merged ${item.dropped} into ${item.kept}`);
  const checks = checklist(result, corpus.text);
  writeJson(join(outDir, `${safeDomainFile(domain)}.json`), { result, checklist: checks, usage: response.usage, model });
  return { domain, passed: checks.passed, cost: cost(response.usage), usage: response.usage };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const domains = (getFlag(args, "domains") ?? "").split(",").map((domain) => domain.trim()).filter(Boolean);
  if (!domains.length) usage(HELP);
  const model = getFlag(args, "model", "gpt-5.4")!;
  const corpusDir = getFlag(args, "corpus", join(ROOT, "scripts", "batch", "corpus"))!;
  const outDir = getFlag(args, "out", join(ROOT, "scripts", "batch", "eval-out"))!;
  const apiKey = envValue("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const rows = [];
  for (const domain of domains) rows.push(await evaluateDomain(domain, model, corpusDir, outDir, apiKey));
  console.log("domain\tstatus\tinput\toutput\tcost_sync\tbatch_note");
  for (const row of rows) {
    console.log(`${row.domain}\t${row.passed ? "pass" : "fail"}\t${row.usage?.prompt_tokens ?? 0}\t${row.usage?.completion_tokens ?? 0}\t$${row.cost.toFixed(4)}\tbatch is half`);
  }
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  console.log(`total_sync_cost=$${totalCost.toFixed(4)} total_batch_estimate=$${(totalCost / 2).toFixed(4)} out=${outDir} (${displaySize(Buffer.byteLength(JSON.stringify(rows)))})`);
  if (rows.some((row) => !row.passed)) process.exit(1);
}

if (import.meta.main) await main();
