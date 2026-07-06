import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveOps, kebabCase, parseOperationArgs, parseRegistryEntries } from "../src/core.ts";

const root = join(import.meta.dir, "..");
const cliPath = join(root, "dist", "cli.js");

const fixtureSpec = {
  openapi: "3.1.0",
  info: {
    title: "fixture",
    version: "1.0.0",
  },
  paths: {
    "/api/search": {
      get: {
        operationId: "search",
        summary: "Search",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          { name: "kind", in: "query", schema: { type: "string", enum: ["mcp", "openapi"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
          { name: "active", in: "query", schema: { type: "boolean", default: true } },
        ],
      },
    },
    "/api/{domain}/surface": {
      get: {
        operationId: "surface",
        summary: "Surface",
        parameters: [
          { name: "domain", in: "path", required: true, schema: { type: "string" } },
        ],
      },
    },
    "/api/{domain}/detect": {
      get: {
        operationId: "detectDomain",
        summary: "Detect",
        parameters: [
          { name: "domain", in: "path", required: true, schema: { type: "string" } },
        ],
      },
    },
    "/api/widgets": {
      post: {
        operationId: "createWidget",
        summary: "Create",
        requestBody: { required: true },
      },
    },
  },
};

function registryEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "mcp/foo",
    kind: "mcp",
    slug: "foo",
    name: "Foo",
    domain: "foo.test",
    popularity: 10,
    ...overrides,
  };
}

function parseSingleJson(stdout: string) {
  const trimmed = stdout.trimEnd();
  expect(stdout).toBe(`${trimmed}\n`);
  const parsed = JSON.parse(trimmed);
  expect(JSON.stringify(parsed)).toBe(trimmed);
  return parsed;
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([cliPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      CI: "1",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runNodeScript(script: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["node", script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      CI: "1",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function startFixtureServer() {
  let poisonOpenApi = false;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/openapi.json") {
        if (poisonOpenApi) return new Response("poisoned", { status: 500 });
        return Response.json(fixtureSpec, {
          headers: {
            "cache-control": "max-age=3600",
            etag: "fixture-v1",
          },
        });
      }
      if (url.pathname === "/api/search") {
        return Response.json({
          results: [
            {
              domain: `${url.searchParams.get("q") ?? "foo"}.test`,
              name: "Foo",
              description: "Fixture result",
              kinds: ["mcp"],
              url: "https://integrations.sh/foo.test/",
            },
          ],
        });
      }
      if (url.pathname === "/api/foo.test/surface") {
        return Response.json({ domain: "foo.test", surfaces: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    base: server.url.href.replace(/\/$/, ""),
    poisonOpenApi() {
      poisonOpenApi = true;
    },
    stop() {
      server.stop(true);
    },
  };
}

describe("pure helpers", () => {
  test("kebabCase normalizes operation ids", () => {
    expect(kebabCase("detectDomain")).toBe("detect-domain");
    expect(kebabCase("HTTP API_lookup")).toBe("http-api-lookup");
  });

  test("deriveOps derives commands, path params, query params, and request bodies", () => {
    const ops = deriveOps(fixtureSpec);
    expect(ops.map((op) => op.cmd)).toEqual(["create-widget", "detect-domain", "search", "surface"]);
    const surface = ops.find((op) => op.cmd === "surface");
    expect(surface?.pathParams.map((param) => param.name)).toEqual(["domain"]);
    const create = ops.find((op) => op.cmd === "create-widget");
    expect(create?.hasBody).toBe(true);
    expect(create?.bodyRequired).toBe(true);
  });

  test("parseOperationArgs validates enums, --no- booleans, defaults, and --data", () => {
    const ops = deriveOps(fixtureSpec);
    const search = ops.find((op) => op.cmd === "search");
    expect(search).toBeDefined();
    const parsed = parseOperationArgs(fixtureSpec, search!, ["--q", "foo", "--kind", "mcp", "--no-active"]);
    expect(parsed.query.get("q")).toEqual(["foo"]);
    expect(parsed.query.get("kind")).toEqual(["mcp"]);
    expect(parsed.query.get("active")).toEqual(["false"]);
    expect(parsed.query.get("limit")).toEqual(["10"]);
    expect(() => parseOperationArgs(fixtureSpec, search!, ["--q", "foo", "--kind", "cli"])).toThrow("--kind must be one of mcp, openapi");

    const create = ops.find((op) => op.cmd === "create-widget");
    expect(create).toBeDefined();
    expect(parseOperationArgs(fixtureSpec, create!, ["--data", "{\"name\":\"Foo\"}"]).data).toBe("{\"name\":\"Foo\"}");
  });

  test("parseRegistryEntries accepts bare arrays and api.json envelopes", () => {
    const entry = registryEntry();
    expect(parseRegistryEntries([entry])).toEqual([entry]);
    expect(parseRegistryEntries({ version: "1", generatedAt: "now", data: [entry] })).toEqual([entry]);
  });
});

describe("built CLI", () => {
  test("search with piped stdout emits exactly one JSON document", async () => {
    const fixture = startFixtureServer();
    const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-test-"));
    try {
      const result = await runCli(["search", "foo"], { INTEGRATIONS_BASE: fixture.base, TMPDIR: tmp });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const json = parseSingleJson(result.stdout);
      expect(json.results[0].domain).toBe("foo.test");
    } finally {
      fixture.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("unknown flags emit structured JSON errors when stdout is piped", async () => {
    const fixture = startFixtureServer();
    const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-test-"));
    try {
      const result = await runCli(["search", "foo", "--bogus"], { INTEGRATIONS_BASE: fixture.base, TMPDIR: tmp });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe("");
      const json = parseSingleJson(result.stdout);
      expect(json.error).toContain("unknown flag --bogus");
    } finally {
      fixture.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("unknown non-domain commands are labeled before domain fallback detail", async () => {
    const fixture = startFixtureServer();
    const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-test-"));
    try {
      const result = await runCli(["serach"], { INTEGRATIONS_BASE: fixture.base, TMPDIR: tmp });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe("");
      const json = parseSingleJson(result.stdout);
      expect(json.error).toContain("unknown command \"serach\" (and no domain match; run \"integrations help\")");
    } finally {
      fixture.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("skill prints bundled markdown by default", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-test-"));
    try {
      const result = await runCli(["skill"], { TMPDIR: tmp });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("# integrations.sh");
      expect(result.stdout).toContain("integrations.sh");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("mcp --json emits hosted MCP metadata", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-test-"));
    try {
      const result = await runCli(["mcp", "--json"], { TMPDIR: tmp });
      expect(result.exitCode).toBe(0);
      const json = parseSingleJson(result.stdout);
      expect(json.url).toBe("https://integrations.sh/mcp");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("bin runs when invoked through a symlink path", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-test-"));
    try {
      const binDir = join(tmp, "bin");
      await mkdir(binDir);
      const link = join(binDir, "integrations");
      await symlink(cliPath, link);

      const result = await runNodeScript(link, ["mcp", "--json"], { TMPDIR: tmp });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const json = parseSingleJson(result.stdout);
      expect(json.url).toBe("https://integrations.sh/mcp");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("spec cache survives a poisoned openapi.json on the second invocation", async () => {
    const fixture = startFixtureServer();
    const tmp = await mkdtemp(join(tmpdir(), "integrations-cli-test-"));
    try {
      const first = await runCli(["search", "foo"], { INTEGRATIONS_BASE: fixture.base, TMPDIR: tmp });
      expect(first.exitCode).toBe(0);
      fixture.poisonOpenApi();
      const second = await runCli(["search", "foo"], { INTEGRATIONS_BASE: fixture.base, TMPDIR: tmp });
      expect(second.exitCode).toBe(0);
      const json = parseSingleJson(second.stdout);
      expect(json.results[0].domain).toBe("foo.test");
    } finally {
      fixture.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
