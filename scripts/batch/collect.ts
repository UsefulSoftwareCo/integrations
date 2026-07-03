import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredDiscovery } from "../../src/lib/discovery-schema.ts";
import {
  envValue,
  getFlag,
  hasFlag,
  parseArgs,
  readJson,
  ROOT,
  safeDomainFile,
  usage,
  validateAndFinalize,
  writeJson,
} from "./shared.ts";

const HELP = `
Usage: bun scripts/batch/collect.ts [--state scripts/batch/state.json | --batch-id id] [flags]

Flags:
  --out dir          Results dir (default: scripts/batch/results)
  --existing dir     Directory of existing KV rows for slug continuity
  --model name       Model label fallback when using --batch-id
  --help             Show this help
`;

type BatchInfo = {
  id: string;
  model: string;
  output_file_id?: string;
  error_file_id?: string;
  status?: string;
  errors?: unknown;
};

type State = { batches?: Array<{ id: string; model: string }> };

async function openai<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`https://api.openai.com/v1${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error?.message ?? `${path} failed: ${res.status}`);
  return body as T;
}

async function downloadFile(apiKey: string, fileId: string): Promise<string> {
  const res = await fetch(`https://api.openai.com/v1/files/${fileId}/content`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`download ${fileId} failed: ${res.status}`);
  return await res.text();
}

function parseModelContent(line: string): { domain: string; raw: unknown; error?: unknown } {
  const row = JSON.parse(line) as {
    custom_id?: string;
    response?: { body?: { choices?: Array<{ message?: { content?: string } }> } };
    error?: unknown;
  };
  const domain = row.custom_id ?? "unknown";
  if (row.error) return { domain, raw: row, error: row.error };
  const content = row.response?.body?.choices?.[0]?.message?.content;
  if (!content) return { domain, raw: row, error: "missing message content" };
  try {
    return { domain, raw: JSON.parse(content) };
  } catch (error) {
    return { domain, raw: content, error: (error as Error).message };
  }
}

async function collectBatch(apiKey: string, batch: { id: string; model: string }, outDir: string, existingDir: string | undefined): Promise<{ ok: number; invalid: number; error: number }> {
  const info = await openai<BatchInfo>(apiKey, `/batches/${batch.id}`);
  console.log(`batch=${batch.id} status=${info.status ?? "unknown"}`);
  const summary = { ok: 0, invalid: 0, error: 0 };
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "_invalid"), { recursive: true });
  mkdirSync(join(outDir, "_errors"), { recursive: true });

  if (info.error_file_id) {
    const text = await downloadFile(apiKey, info.error_file_id);
    writeFileSync(join(outDir, "_errors", `${batch.id}.jsonl`), text);
    summary.error += text.trim() ? text.trim().split(/\n/).length : 0;
  }
  if (!info.output_file_id) return summary;
  const text = await downloadFile(apiKey, info.output_file_id);
  writeFileSync(join(outDir, `${batch.id}.output.jsonl`), text);
  for (const line of text.split(/\n/).filter(Boolean)) {
    const parsed = parseModelContent(line);
    if (parsed.error) {
      summary.error++;
      writeJson(join(outDir, "_invalid", `${safeDomainFile(parsed.domain)}.json`), parsed);
      continue;
    }
    try {
      const { result, collapses } = validateAndFinalize(parsed.domain, parsed.raw, existingDir);
      for (const item of collapses) console.log(`dedup: ${item.domain} merged ${item.dropped} into ${item.kept}`);
      const stored: StoredDiscovery = { result, discoveredAt: new Date().toISOString(), model: `batch-${batch.model}` };
      writeJson(join(outDir, `${safeDomainFile(parsed.domain)}.json`), stored);
      summary.ok++;
    } catch (error) {
      summary.invalid++;
      writeJson(join(outDir, "_invalid", `${safeDomainFile(parsed.domain)}.json`), {
        domain: parsed.domain,
        error: (error as Error).message,
        raw: parsed.raw,
      });
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (hasFlag(args, "help")) usage(HELP);
  const apiKey = envValue("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const outDir = getFlag(args, "out", join(ROOT, "scripts", "batch", "results"))!;
  const existingDir = getFlag(args, "existing");
  const batchId = getFlag(args, "batch-id");
  const statePath = getFlag(args, "state", join(ROOT, "scripts", "batch", "state.json"))!;
  const batches = batchId
    ? [{ id: batchId, model: getFlag(args, "model", "unknown")! }]
    : (existsSync(statePath) ? readJson<State>(statePath).batches ?? [] : []);
  if (!batches.length) throw new Error("no batches found; pass --batch-id or a populated --state file");

  const total = { ok: 0, invalid: 0, error: 0 };
  for (const batch of batches) {
    const s = await collectBatch(apiKey, batch, outDir, existingDir);
    total.ok += s.ok;
    total.invalid += s.invalid;
    total.error += s.error;
  }
  console.log(`summary ok=${total.ok} invalid=${total.invalid} error=${total.error}`);
}

await main();
