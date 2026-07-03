import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../../src/lib/detect.ts";
import { discover, type ChatFn, type DiscoverEvent, type ParsedToolCall, type WebBackend } from "../../src/lib/discover.ts";
import { contextWeb } from "../../src/lib/contextdev.ts";
import { dedupSurfacesWithReport } from "./dedup.ts";
import {
  appendJsonl,
  envValue,
  getFlag,
  getNumberFlag,
  hasFlag,
  mapLimit,
  parseArgs,
  readPriorSurfaces,
  ROOT,
  safeDomainFile,
  usage,
  writeJson,
} from "./shared.ts";
import { packDiscovery, preserveSlugs } from "../../worker/operations.ts";

const HELP = `
Usage: bun scripts/batch/run-loop.ts --domains file-or-csv [flags]

Flags:
  --model name       OpenAI model (default: gpt-5.4)
  --concurrency n    Domains in flight (default: 8)
  --out dir          Results dir (default: scripts/batch/results)
  --existing dir     Directory of existing StoredDiscovery rows for slug continuity
  --no-scrape-cache  Bypass the local context.dev scrape/search/sitemap cache
  --scrape-cache-dir Directory for the local scrape cache (default: scripts/batch/scrape-cache)
  --force            Re-run domains whose output file already exists
  --help             Show this help
`;

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatCompletion = {
  choices?: Array<{ message?: { role: string; content?: string | null; tool_calls?: OpenAiToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

type RunStats = {
  turns: number;
  chatRequests: number;
  maxAttempt: number;
  usage: Usage;
};

type CacheStats = {
  hits: number;
  misses: number;
};

type RunDomainOptions = {
  apiKey: string;
  contextKey: string;
  model: string;
  outDir: string;
  existingDir?: string;
  force: boolean;
  useScrapeCache: boolean;
  scrapeCacheDir?: string;
};

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function addUsage(total: Usage, usage: ChatCompletion["usage"]): void {
  total.prompt_tokens += usage?.prompt_tokens ?? 0;
  total.completion_tokens += usage?.completion_tokens ?? 0;
  total.total_tokens += usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
}

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createChat(apiKey: string, model: string, stats: RunStats): ChatFn {
  return async (messages, tools) => {
    stats.turns++;
    let lastError = "";
    for (let attempt = 1; attempt <= 8; attempt++) {
      stats.maxAttempt = Math.max(stats.maxAttempt, attempt);
      stats.chatRequests++;
      const body: Record<string, unknown> = { model, messages, tools, tool_choice: "auto", parallel_tool_calls: true };
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as ChatCompletion;
      if (res.ok) {
        addUsage(stats.usage, data.usage);
        const message = data.choices?.[0]?.message ?? { role: "assistant", content: "" };
        const toolCalls: ParsedToolCall[] = (message.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: parseToolArgs(tc.function.arguments),
        }));
        return { message, toolCalls };
      }
      lastError = data.error?.message ?? `OpenAI chat completion failed: HTTP ${res.status}`;
      if (!isTransient(res.status) || attempt === 8) throw new Error(lastError);
      // Rate limits tell us how long to wait — honor that over blind backoff
      // (TPM windows outlast a fast exponential ramp when domains run in parallel).
      const retryAfter = Number(res.headers.get("retry-after")) * 1000 || (Number(/try again in ([\d.]+)s/.exec(lastError)?.[1]) || 0) * 1000;
      await sleep(Math.max(retryAfter + 1000, Math.min(30_000, 500 * 2 ** (attempt - 1))));
    }
    throw new Error(lastError || "OpenAI chat completion failed");
  };
}

function readDomains(input: string): string[] {
  const text = existsSync(input) ? readFileSync(input, "utf8") : input;
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const domain = part.trim().toLowerCase();
    if (!domain || domain.startsWith("#")) continue;
    seen.add(domain);
  }
  return [...seen];
}

function requireSecrets(): { openai: string; contextDev: string } {
  const openai = envValue("OPENAI_API_KEY");
  const contextDev = envValue("CONTEXT_DEV_API_KEY");
  const missing = [
    ["OPENAI_API_KEY", openai],
    ["CONTEXT_DEV_API_KEY", contextDev],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing required env: ${missing.join(", ")}`);
  return { openai: openai!, contextDev: contextDev! };
}

function countCreds(result: { credentials?: unknown }): number {
  return result.credentials && typeof result.credentials === "object" && !Array.isArray(result.credentials)
    ? Object.keys(result.credentials).length
    : 0;
}

async function runDomain(domain: string, opts: RunDomainOptions): Promise<void> {
  const outPath = join(opts.outDir, `${safeDomainFile(domain)}.json`);
  if (!opts.force && existsSync(outPath)) {
    console.log(`${domain}\tskipped existing ${outPath}`);
    return;
  }

  const started = Date.now();
  const stats: RunStats = {
    turns: 0,
    chatRequests: 0,
    maxAttempt: 1,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  let cacheStats: CacheStats | undefined;
  const cacheLog = () =>
    opts.useScrapeCache
      ? `\tcacheHits=${cacheStats?.hits ?? 0}\tcacheMisses=${cacheStats?.misses ?? 0}`
      : "\tcache=off";
  try {
    const d = await detect(domain);
    const events: DiscoverEvent[] = [];
    // Record everywhere the loop actually looked — grounding checks trust
    // visited hosts (docs often live off-domain, e.g. canva.dev for canva.com).
    const visited = new Set<string>();
    // Every URL the model could have literally read: visited pages plus URLs
    // appearing in scraped content — the grounding universe for the checker.
    const seenUrls = new Set<string>();
    const noteUrls = (text: string) => {
      for (const m of text.match(/https?:\/\/[^\s"'<>)\],`\\]+/g) ?? []) seenUrls.add(m.replace(/[.,;:]+$/, ""));
    };
    let inner: WebBackend = contextWeb(opts.contextKey);
    if (opts.useScrapeCache) {
      const { cachedWeb } = await import("./scrape-cache.ts");
      const cached = cachedWeb(inner, opts.scrapeCacheDir);
      inner = cached;
      cacheStats = cached.cacheStats;
    }
    const web: WebBackend = {
      canSearch: inner.canSearch,
      async search(query) {
        const hits = await inner.search(query);
        for (const hit of hits) {
          visited.add(hit.url);
          seenUrls.add(hit.url);
        }
        return hits;
      },
      async scrape(url) {
        visited.add(url);
        seenUrls.add(url);
        const content = await inner.scrape(url);
        noteUrls(content);
        return content;
      },
      async sitemap(dom, urlRegex) {
        const urls = await inner.sitemap(dom, urlRegex);
        for (const url of urls) {
          visited.add(url);
          seenUrls.add(url);
        }
        return urls;
      },
    };
    // detect() reads llms.txt/manifests itself — their contents ground URLs
    // the model cites without a separate scrape (craime.se → api.lagenta.ai).
    if (d.llmsTxt) {
      try {
        noteUrls(await (await fetch(`https://${d.domain}/llms.txt`, { signal: AbortSignal.timeout(10_000) })).text());
      } catch { /* grounding enrichment only */ }
    }
    const disc = await discover(d.domain, d, createChat(opts.apiKey, opts.model, stats), web, (event) => events.push(event));
    if (!disc) throw new Error("discovery loop returned null");

    let result = packDiscovery(d.domain, d, disc, true) as {
      domain: string;
      credentials?: unknown;
      surfaces?: Array<{ slug: string; type: string; docs?: string; url?: string; spec?: string; command?: string; packages?: Array<{ identifier?: string }> }>;
    };
    if (Array.isArray(result.surfaces)) preserveSlugs(result.surfaces, readPriorSurfaces(opts.existingDir, d.domain));
    const deduped = dedupSurfacesWithReport(result, d.domain);
    for (const item of deduped.collapses) console.log(`dedup: ${item.domain} merged ${item.dropped} into ${item.kept}`);
    result = deduped.result as typeof result;
    demoteBadSpecShapes(result, d.domain);
    demoteBadMcpUrls(result, d.domain);
    demoteExampleHosts(result, d.domain);
    if (Array.isArray(result.surfaces)) preserveSlugs(result.surfaces, readPriorSurfaces(opts.existingDir, d.domain));

    writeJson(outPath, {
      result,
      discoveredAt: new Date().toISOString(),
      model: `loop-${opts.model}`,
      usage: stats.usage,
      visited: [...visited].sort(),
      grounding: [...seenUrls].sort(),
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${d.domain}\tsurfaces=${result.surfaces?.length ?? 0}\tcreds=${countCreds(result)}\tturns=${stats.turns}\ttokens=${stats.usage.total_tokens}\tseconds=${seconds}${cacheLog()}`);
  } catch (error) {
    appendJsonl(join(opts.outDir, "_failures.jsonl"), {
      domain,
      error: error instanceof Error ? error.message : String(error),
      attemptCount: stats.maxAttempt,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${domain}\tfailed\tturns=${stats.turns}\ttokens=${stats.usage.total_tokens}\tseconds=${seconds}${cacheLog()}`);
  }
}

function demoteBadSpecShapes(
  result: { surfaces?: Array<{ name?: string; type?: string; docs?: string; spec?: string }> },
  domain: string,
): void {
  if (!Array.isArray(result.surfaces)) return;
  for (const surface of result.surfaces) {
    // http only: graphql specs passed live validation in-loop (SDL URLs and
    // auth-gated endpoints legitimately fail the URL-shape heuristic).
    if (surface.type !== "http") continue;
    if (!surface.spec || looksMachineReadableSpecUrl(surface.spec)) continue;
    const spec = surface.spec;
    delete surface.spec;
    if (!surface.docs) surface.docs = spec;
    console.log(`spec-shape: ${domain} demoted ${surface.name ?? surface.type ?? "surface"} spec ${spec}`);
  }
}

/** An mcp `url` must be a connect endpoint. Auth/login/settings funnels are
 * noise — demote to docs. GitHub repos stay: they locate local servers. */
function demoteBadMcpUrls(
  result: { surfaces?: Array<{ name?: string; type?: string; docs?: string; url?: string }> },
  domain: string,
): void {
  if (!Array.isArray(result.surfaces)) return;
  for (const surface of result.surfaces) {
    if (surface.type !== "mcp" || !surface.url) continue;
    if (!/[?&](redirect|returnTo|continue)=|\/(login|signin|sign-in|choose-org|settings)\b|^https?:\/\/docs\.|\/docs\//i.test(surface.url)) continue;
    const url = surface.url;
    delete surface.url;
    if (!surface.docs) surface.docs = url;
    console.log(`mcp-url: ${domain} demoted ${surface.name ?? "mcp surface"} url ${url}`);
  }
}

/** example.com/org hosts are spec-placeholder servers (RFC 2606), never real
 * endpoints — the model copies them out of OpenAPI `servers` blocks. */
function demoteExampleHosts(
  result: { surfaces?: Array<{ name?: string; type?: string; url?: string; notes?: string }> },
  domain: string,
): void {
  if (!Array.isArray(result.surfaces)) return;
  for (const surface of result.surfaces) {
    if (!surface.url || !/\/\/([a-z0-9-]+\.)*example\.(com|org|net)([:/]|$)/i.test(surface.url)) continue;
    const url = surface.url;
    delete surface.url;
    surface.notes = ((surface.notes ?? "") + " Docs show a placeholder server host; the real base URL is tenant- or deployment-specific.").trim();
    console.log(`example-host: ${domain} demoted ${surface.name ?? surface.type ?? "surface"} url ${url}`);
  }
}

function looksMachineReadableSpecUrl(spec: string): boolean {
  return /\.(json|ya?ml)([?#]|$)|openapi|swagger/i.test(spec) || spec === "introspection";
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const domainArg = getFlag(args, "domains");
  if (!domainArg) usage(HELP);
  const model = getFlag(args, "model", "gpt-5.4")!;
  const concurrency = getNumberFlag(args, "concurrency", 8);
  const outDir = getFlag(args, "out", join(ROOT, "scripts", "batch", "results"))!;
  const existingDir = getFlag(args, "existing");
  const useScrapeCache = !hasFlag(args, "no-scrape-cache");
  const scrapeCacheDir = getFlag(args, "scrape-cache-dir");
  const force = hasFlag(args, "force");
  const secrets = requireSecrets();
  const domains = readDomains(domainArg);
  if (!domains.length) throw new Error("no domains found");
  mkdirSync(outDir, { recursive: true });
  await mapLimit(domains, concurrency, (domain) =>
    runDomain(domain, { apiKey: secrets.openai, contextKey: secrets.contextDev, model, outDir, existingDir, force, useScrapeCache, scrapeCacheDir }));
}

await main();
