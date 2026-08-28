#!/usr/bin/env bun
/**
 * Probes every catalogued MCP endpoint and records whether it answers like an
 * MCP server.
 *
 * WHY THIS EXISTS. A large share of MCP surfaces reached the catalog from LLM
 * discovery, which is happy to assert that a service runs a server at
 * `https://<domain>/mcp` because that is the common convention. 150 catalogued
 * endpoints have exactly that shape and none carry a verification basis. They
 * cannot be judged by inspection — probing shows the guess is right far more
 * often than it looks: `logging.googleapis.com/mcp` and
 * `orgpolicy.googleapis.com/mcp` return valid initialize results, while
 * `gmail.googleapis.com/mcp` 404s. Only the wire can tell them apart.
 *
 * The verdicts are conservative on purpose. A dead endpoint is one the network
 * positively denies (404/410, unknown host, refused connection). Anything
 * ambiguous — a timeout, a 5xx, a proxy error — is `unknown` and changes
 * nothing, because a service being down for a minute is not evidence that it
 * does not exist. Only `dead` removes a record.
 *
 * Output: output/mcp-endpoints.json, tracked like the other slow network caches
 * (output/tools, output/favicons.json). `normalize.ts` reads it; nothing here
 * runs at build time.
 *
 * Usage:
 *   bun run scripts/verify-mcp-endpoints.ts            # probe everything
 *   bun run scripts/verify-mcp-endpoints.ts --stale 30 # only re-probe entries older than 30 days
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "output");
const CACHE = join(OUTPUT, "mcp-endpoints.json");

const CONCURRENCY = 24;
const TIMEOUT_MS = 12_000;

export type EndpointStatus = "live" | "auth" | "dead" | "unknown";

export interface EndpointVerdict {
  readonly status: EndpointStatus;
  /** Short human reason, for auditing a verdict without re-probing. */
  readonly detail: string;
  readonly checkedAt: string;
}

interface Cache {
  readonly checkedAt: string;
  readonly endpoints: Record<string, EndpointVerdict>;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "integrations.sh-verify", version: "1" },
  },
});

/** An MCP server answers `initialize` with a JSON-RPC result carrying a
 *  protocol version — over plain JSON or as an SSE `data:` frame. */
const looksLikeMcp = (body: string): boolean => {
  const payloads = body.includes("data:")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [body];
  for (const payload of payloads) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: JSON.parse reports malformed input by throwing
    try {
      const parsed = JSON.parse(payload) as { result?: { protocolVersion?: unknown } };
      if (parsed?.result?.protocolVersion !== undefined) return true;
    } catch {
      continue;
    }
  }
  return false;
};

const verdictFor = async (url: string): Promise<EndpointVerdict> => {
  const checkedAt = new Date().toISOString();
  const response = await (async () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch reports transport failure by rejecting
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: INITIALIZE,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();

  if (response instanceof Error) {
    const message = response.message.toLowerCase();
    // A host that does not resolve, or refuses the connection outright, is a
    // positive denial. A timeout is not.
    const denied =
      message.includes("dns") ||
      message.includes("getaddrinfo") ||
      message.includes("enotfound") ||
      message.includes("unable to connect") ||
      message.includes("econnrefused") ||
      message.includes("certificate");
    return {
      status: denied ? "dead" : "unknown",
      detail: response.message.slice(0, 140),
      checkedAt,
    };
  }

  // A server that demands credentials is a server.
  if (response.status === 401 || response.status === 403) {
    return { status: "auth", detail: `HTTP ${response.status}`, checkedAt };
  }
  if (response.status === 404 || response.status === 410) {
    return { status: "dead", detail: `HTTP ${response.status}`, checkedAt };
  }
  if (!response.ok) {
    return { status: "unknown", detail: `HTTP ${response.status}`, checkedAt };
  }

  const body = await (async () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: body read can fail mid-stream
    try {
      return await response.text();
    } catch {
      return "";
    }
  })();
  if (looksLikeMcp(body)) {
    return { status: "live", detail: `HTTP ${response.status}, initialize ok`, checkedAt };
  }
  // 200 is not proof: an API gateway will happily return its own JSON for an
  // unrouted path. Without an initialize result this is not an MCP server, but
  // it answered, so call it unknown rather than dead.
  return { status: "unknown", detail: `HTTP ${response.status}, no initialize result`, checkedAt };
};

const endpointsFromCatalog = (): string[] => {
  const path = join(OUTPUT, "mcp.json");
  if (!existsSync(path)) {
    console.error("output/mcp.json is missing — run `bun run normalize` first.");
    process.exit(1);
  }
  const records = JSON.parse(readFileSync(path, "utf8")) as {
    mcp?: { remoteUrl?: string };
  }[];
  const urls = new Set<string>();
  for (const record of records) {
    const url = record.mcp?.remoteUrl?.trim();
    if (url && /^https?:\/\//i.test(url)) urls.add(url);
  }
  return [...urls].sort();
};

const readCache = (): Cache =>
  existsSync(CACHE)
    ? (JSON.parse(readFileSync(CACHE, "utf8")) as Cache)
    : { checkedAt: "", endpoints: {} };

async function main(): Promise<void> {
  const staleArg = process.argv.indexOf("--stale");
  const staleDays = staleArg >= 0 ? Number(process.argv[staleArg + 1] ?? "0") : 0;
  const staleBefore =
    staleDays > 0 ? Date.now() - staleDays * 24 * 60 * 60 * 1000 : Number.POSITIVE_INFINITY;

  const previous = readCache();
  const urls = endpointsFromCatalog();
  const todo = urls.filter((url) => {
    const seen = previous.endpoints[url];
    if (!seen) return true;
    return Date.parse(seen.checkedAt) < staleBefore;
  });

  console.log(`${urls.length} catalogued endpoints, ${todo.length} to probe`);
  const endpoints: Record<string, EndpointVerdict> = { ...previous.endpoints };
  let done = 0;

  const queue = [...todo];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let url = queue.pop(); url !== undefined; url = queue.pop()) {
      endpoints[url] = await verdictFor(url);
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${todo.length}`);
    }
  });
  await Promise.all(workers);

  mkdirSync(OUTPUT, { recursive: true });
  const ordered = Object.fromEntries(Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    CACHE,
    JSON.stringify({ checkedAt: new Date().toISOString(), endpoints: ordered }, null, 2) + "\n",
  );

  const tally: Record<string, number> = {};
  for (const verdict of Object.values(ordered)) {
    tally[verdict.status] = (tally[verdict.status] ?? 0) + 1;
  }
  console.log("verdicts:", tally);
}

await main();
