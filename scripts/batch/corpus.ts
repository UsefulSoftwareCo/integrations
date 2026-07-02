import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../../src/lib/detect.ts";
import { contextWeb, naiveWeb } from "../../src/lib/contextdev.ts";
import type { WebBackend } from "../../src/lib/discover.ts";
import {
  appendJsonl,
  displaySize,
  envValue,
  getFlag,
  getNumberFlag,
  hasFlag,
  mapLimit,
  parseArgs,
  readLines,
  safeDomainFile,
  usage,
  writeJson,
} from "./shared.ts";

type CorpusPage = { url: string; title: string; content: string; priority: number };
type Corpus = { domain: string; detect: Awaited<ReturnType<typeof detect>>; pages: Array<Omit<CorpusPage, "priority">> };

const HELP = `
Usage: bun scripts/batch/corpus.ts --domains domains.txt --out scripts/batch/corpus/ [flags]

Flags:
  --max-pages N       Pages per domain (default: 12)
  --concurrency N     Domains in parallel (default: 8)
  --timeout-ms N      Per-domain timeout (default: 60000)
  --max-bytes N       Approx JSON bytes per domain (default: 150000)
  --force             Rebuild existing corpus files
  --help              Show this help
`;

function candidates(domain: string, det: Awaited<ReturnType<typeof detect>>): Array<{ url: string; priority: number }> {
  const urls: Array<{ url: string; priority: number }> = [];
  const add = (url: string | undefined, priority: number) => {
    if (!url) return;
    try {
      const u = new URL(url.startsWith("http") ? url : `https://${domain}${url.startsWith("/") ? "" : "/"}${url}`);
      if (!/^https?:$/.test(u.protocol)) return;
      urls.push({ url: u.toString(), priority });
    } catch {
      /* ignore malformed candidates */
    }
  };

  add(`https://${domain}/llms.txt`, 100);
  add(`https://${domain}/.well-known/api-catalog`, 95);
  add(`https://${domain}/.well-known/mcp/server-card.json`, 94);
  add(`https://${domain}/.well-known/agent-card.json`, 90);
  add(`https://${domain}/.well-known/oauth-protected-resource`, 88);
  for (const url of det.apiCatalog?.docs ?? []) add(url, 86);
  for (const url of det.apiCatalog?.openapi ?? []) add(url, 84);
  if (det.apiSchema?.url) add(det.apiSchema.url, 82);
  for (const path of ["/docs", "/developers", "/developer", "/api", "/api-reference", "/docs/api", "/reference", "/openapi.json", "/swagger.json"]) {
    add(path, 70);
  }
  add(`https://docs.${domain}/`, 78);
  add(`https://developers.${domain}/`, 76);
  add(`https://developer.${domain}/`, 76);
  add(`https://api.${domain}/docs`, 74);

  return dedupe(urls).sort((a, b) => b.priority - a.priority);
}

function dedupe<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = item.url.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function sitemapCandidates(domain: string): Promise<Array<{ url: string; priority: number }>> {
  const out: Array<{ url: string; priority: number }> = [];
  const keep = /\/(?:docs?|developers?|api|reference|graphql|mcp|oauth|cli|sdk)(?:\/|$|-)/i;
  for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
    try {
      const res = await fetch(`https://${domain}${path}`, { headers: { "user-agent": "integrations.sh-batch/0.1" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      const matches = text.match(/<loc>\s*([^<]+)\s*<\/loc>/gi) ?? [];
      for (const m of matches) {
        const url = m.replace(/<\/?loc>/gi, "").trim();
        if (keep.test(new URL(url).pathname)) out.push({ url, priority: 60 });
      }
    } catch {
      /* sitemap is optional */
    }
  }
  return out.slice(0, 80);
}

function titleFrom(content: string, url: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1] ?? /^(.+)\n=+$/m.exec(content)?.[1];
  if (heading) return heading.trim().slice(0, 140);
  try {
    return new URL(url).pathname.replace(/^\/|\/$/g, "") || new URL(url).hostname;
  } catch {
    return url;
  }
}

function lightReadable(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => `\n${"#".repeat(Number(level))} ${stripTags(body)}\n`)
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => `${stripTags(body)} (${href})`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, body) => `\`${stripTags(body)}\``)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => `\n\`\`\`\n${stripTags(body)}\n\`\`\`\n`)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function scrapePage(web: WebBackend, url: string): Promise<string> {
  const content = await web.scrape(url);
  return lightReadable(content).slice(0, 20_000);
}

function capCorpus(domain: string, det: Awaited<ReturnType<typeof detect>>, pages: CorpusPage[], maxBytes: number): Corpus {
  let kept = pages.slice().sort((a, b) => b.priority - a.priority);
  for (;;) {
    const corpus: Corpus = { domain, detect: det, pages: kept.map(({ priority: _priority, ...page }) => page) };
    const size = Buffer.byteLength(JSON.stringify(corpus));
    if (size <= maxBytes || kept.length <= 1) return corpus;
    kept = kept.slice(0, -1);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildDomain(domain: string, outDir: string, web: WebBackend, maxPages: number, maxBytes: number): Promise<void> {
  const outPath = join(outDir, `${safeDomainFile(domain)}.json`);
  const det = await detect(domain);
  const allCandidates = dedupe([...candidates(domain, det), ...(await sitemapCandidates(domain))]);
  const pages: CorpusPage[] = [];
  for (const item of allCandidates) {
    if (pages.length >= maxPages) break;
    const content = await scrapePage(web, item.url).catch(() => "");
    if (!content || /^HTTP \d+|failed|scrape failed|scrape error/i.test(content)) continue;
    pages.push({ url: item.url, title: titleFrom(content, item.url), content, priority: item.priority });
  }
  writeJson(outPath, capCorpus(domain, det, pages, maxBytes));
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const domainsPath = getFlag(args, "domains");
  const outDir = getFlag(args, "out");
  if (!domainsPath || !outDir) usage(HELP);

  mkdirSync(outDir, { recursive: true });
  const maxPages = getNumberFlag(args, "max-pages", 12);
  const concurrency = getNumberFlag(args, "concurrency", 8);
  const timeoutMs = getNumberFlag(args, "timeout-ms", 60_000);
  const maxBytes = getNumberFlag(args, "max-bytes", 150_000);
  const force = hasFlag(args, "force");
  const key = envValue("CONTEXT_DEV_API_KEY");
  const web = key ? contextWeb(key) : naiveWeb();
  const domains = readLines(domainsPath);
  const failures = join(outDir, "_failures.jsonl");

  await mapLimit(domains, concurrency, async (domain) => {
    const outPath = join(outDir, `${safeDomainFile(domain)}.json`);
    if (!force && existsSync(outPath)) {
      console.log(`${domain} skipped ${displaySize(statSync(outPath).size)}`);
      return;
    }
    const start = Date.now();
    try {
      await withTimeout(buildDomain(domain, outDir, web, maxPages, maxBytes), timeoutMs);
      const size = existsSync(outPath) ? statSync(outPath).size : 0;
      const pages = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")).pages?.length ?? 0 : 0;
      console.log(`${domain} ok pages=${pages} size=${displaySize(size)} ms=${Date.now() - start}`);
    } catch (error) {
      console.log(`${domain} failed ${(error as Error).message}`);
      appendJsonl(failures, { domain, error: (error as Error).message, at: new Date().toISOString() });
    }
  });
}

await main();
