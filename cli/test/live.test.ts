import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");
const cliPath = join(root, "dist", "cli.js");
const liveTest = process.env.INTEGRATIONS_LIVE === "0" ? test.skip : test;

function parseSingleJson(stdout: string) {
  const trimmed = stdout.trimEnd();
  expect(stdout).toBe(`${trimmed}\n`);
  const parsed = JSON.parse(trimmed);
  expect(JSON.stringify(parsed)).toBe(trimmed);
  return parsed;
}

async function runCli(args: string[], tmp: string) {
  const env = {
    ...process.env,
    TMPDIR: tmp,
    CI: "1",
    NO_COLOR: "1",
  };
  delete env.INTEGRATIONS_BASE;

  const proc = Bun.spawn([cliPath, ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

liveTest("production smoke: search, surface lookup, and detect parse as JSON", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-live-"));
  try {
    const search = await runCli(["search", "stripe", "--json"], tmp);
    expect(search.exitCode).toBe(0);
    expect(search.stderr).toBe("");
    const searchJson = parseSingleJson(search.stdout);
    expect(searchJson.results.length).toBeGreaterThanOrEqual(1);

    const surface = await runCli(["stripe.com"], tmp);
    expect(surface.exitCode).toBe(0);
    const surfaceJson = parseSingleJson(surface.stdout);
    expect(surfaceJson.domain).toBe("stripe.com");

    const detect = await runCli(["detect", "resend.com", "--json"], tmp);
    expect(detect.exitCode).toBe(0);
    const detectJson = parseSingleJson(detect.stdout);
    expect(detectJson.domain).toBe("resend.com");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
