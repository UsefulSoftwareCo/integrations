import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  displaySize,
  envValue,
  fileDomain,
  getFlag,
  getNumberFlag,
  hasFlag,
  listJsonFiles,
  parseArgs,
  readJson,
  ROOT,
  usage,
  writeJson,
} from "./shared.ts";

const HELP = `
Usage: bun scripts/batch/submit.ts --corpus scripts/batch/corpus/ [flags]

Flags:
  --model name             OpenAI model (default: gpt-5.4)
  --max-completion-tokens N (default: 16000)
  --max-requests N         Requests per batch file (default: 50000)
  --max-file-mb N          Max JSONL file size (default: 200)
  --out dir                JSONL output dir (default: scripts/batch/submissions)
  --state file             State file (default: scripts/batch/state.json)
  --dry-run                Write JSONL and print estimate, submit nothing
  --help                   Show this help
`;

type PromptModule = {
  SYSTEM: string;
  buildUserMessage(domain: string, corpus: unknown, detect?: unknown): string;
  DISCOVERY_JSON_SCHEMA: object;
};

type BatchState = {
  batches: Array<{ id: string; inputFileId: string; jsonl: string; model: string; requestCount: number; bytes: number; createdAt: string }>;
};

async function loadPrompt(): Promise<PromptModule> {
  const realPrompt = "./discovery-prompt.ts";
  try {
    return (await import(realPrompt)) as PromptModule;
  } catch {
    return (await import("./discovery-prompt-stub.ts")) as PromptModule;
  }
}

function requestFor(domain: string, corpus: unknown, prompt: PromptModule, model: string, maxCompletionTokens: number): object {
  const pages = corpus && typeof corpus === "object" && Array.isArray((corpus as { pages?: unknown }).pages)
    ? (corpus as { pages: unknown }).pages
    : corpus;
  const detect = corpus && typeof corpus === "object" ? (corpus as { detect?: unknown }).detect : undefined;
  const userContent = prompt.buildUserMessage(domain, pages, detect);
  return {
    custom_id: domain,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model,
      messages: [
        { role: "system", content: prompt.SYSTEM },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_schema", json_schema: prompt.DISCOVERY_JSON_SCHEMA },
      max_completion_tokens: maxCompletionTokens,
    },
  };
}

function writeChunks(lines: string[], outDir: string, maxRequests: number, maxBytes: number): Array<{ path: string; count: number; bytes: number }> {
  mkdirSync(outDir, { recursive: true });
  const chunks: Array<{ path: string; count: number; bytes: number }> = [];
  let current: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (!current.length) return;
    const path = join(outDir, `batch-${String(chunks.length + 1).padStart(3, "0")}.jsonl`);
    const text = `${current.join("\n")}\n`;
    writeFileSync(path, text);
    chunks.push({ path, count: current.length, bytes: Buffer.byteLength(text) });
    current = [];
    bytes = 0;
  };
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`);
    if (current.length && (current.length >= maxRequests || bytes + lineBytes > maxBytes)) flush();
    current.push(line);
    bytes += lineBytes;
  }
  flush();
  return chunks;
}

async function uploadFile(apiKey: string, path: string): Promise<string> {
  const form = new FormData();
  form.set("purpose", "batch");
  form.set("file", new Blob([readFileSync(path)]), path.split("/").at(-1));
  const res = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form });
  const body = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(body.error?.message ?? `file upload failed: ${res.status}`);
  return body.id;
}

async function createBatch(apiKey: string, inputFileId: string, model: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/batches", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
      metadata: { job: "integrations-discovery", model },
    }),
  });
  const body = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(body.error?.message ?? `batch create failed: ${res.status}`);
  return body.id;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const corpusDir = getFlag(args, "corpus");
  if (!corpusDir) usage(HELP);
  const model = getFlag(args, "model", "gpt-5.4")!;
  const maxCompletionTokens = getNumberFlag(args, "max-completion-tokens", 16_000);
  const maxRequests = getNumberFlag(args, "max-requests", 50_000);
  const maxBytes = getNumberFlag(args, "max-file-mb", 200) * 1024 * 1024;
  const outDir = getFlag(args, "out", join(ROOT, "scripts", "batch", "submissions"))!;
  const statePath = getFlag(args, "state", join(ROOT, "scripts", "batch", "state.json"))!;
  const dryRun = hasFlag(args, "dry-run");
  const prompt = await loadPrompt();

  const lines = listJsonFiles(corpusDir).map((path) => {
    const domain = fileDomain(path);
    return JSON.stringify(requestFor(domain, readJson(path), prompt, model, maxCompletionTokens));
  });
  const chunks = writeChunks(lines, outDir, maxRequests, maxBytes);
  const totalBytes = chunks.reduce((sum, c) => sum + c.bytes, 0);
  const inputTokens = Math.ceil(totalBytes / 4);
  const outputTokens = lines.length * maxCompletionTokens;
  const inputCost = (inputTokens / 1_000_000) * 1.25;
  const maxOutputCost = (outputTokens / 1_000_000) * 7.5;

  console.log(`requests=${lines.length} chunks=${chunks.length} jsonl=${displaySize(totalBytes)}`);
  console.log(`estimate input_tokens=${inputTokens} max_output_tokens=${outputTokens} cost=$${(inputCost + maxOutputCost).toFixed(2)} input=$${inputCost.toFixed(2)} max_output=$${maxOutputCost.toFixed(2)}`);
  for (const chunk of chunks) console.log(`${chunk.path} requests=${chunk.count} size=${displaySize(statSync(chunk.path).size)}`);
  if (dryRun) return;

  const apiKey = envValue("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required unless --dry-run is set");
  const state: BatchState = existsSync(statePath) ? readJson(statePath) : { batches: [] };
  for (const chunk of chunks) {
    const inputFileId = await uploadFile(apiKey, chunk.path);
    const id = await createBatch(apiKey, inputFileId, model);
    state.batches.push({ id, inputFileId, jsonl: chunk.path, model, requestCount: chunk.count, bytes: chunk.bytes, createdAt: new Date().toISOString() });
    writeJson(statePath, state);
    console.log(`submitted batch=${id} file=${inputFileId} requests=${chunk.count}`);
  }
}

await main();
