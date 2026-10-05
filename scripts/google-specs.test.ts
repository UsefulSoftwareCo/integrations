import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTP_METHODS, hostedGoogleSpec, parseJsonObject, type JsonObject } from "./google-specs.ts";

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "specs", "google");
const files = readdirSync(SPECS).filter((file) => file.startsWith("google-") && file.endsWith(".json"));
const read = (file: string): JsonObject =>
  parseJsonObject(readFileSync(join(SPECS, file), "utf8"), file);

type Operation = { servers?: { url: string }[]; parameters?: { name: string; schema: JsonObject }[] };
// SAFETY: test-only view of a converted spec's paths. Every assertion below
// compares against literal expectations, so a wrong shape fails the test.
const pathsOf = (spec: JsonObject) => spec.paths as Record<string, Record<string, Operation>>;
const operations = (spec: JsonObject) =>
  Object.entries(pathsOf(spec)).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );
const parameter = (spec: JsonObject, path: string, method: string, name: string) =>
  pathsOf(spec)[path]?.[method]?.parameters?.find((each) => each.name === name)?.schema;

describe("hosted Google specs", () => {
  test("every committed spec is already in its hosted form", () => {
    expect(files.length).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(join(SPECS, "manifest.json"), "utf8")) as {
      specs: Record<string, { server: string; operations: number }>;
    };
    for (const file of files) {
      const spec = read(file);
      const hosted = hostedGoogleSpec(spec, file);
      expect(hosted?.document).toEqual(spec);
      expect(manifest.specs[file.replace(/\.json$/, "")]).toMatchObject({
        server: hosted?.server,
        operations: hosted?.operations,
      });
    }
  });

  test("Gmail is addressed at its own host and its defaults are typed", () => {
    const gmail = read("google-gmail.json");
    expect(gmail.servers).toEqual([{ url: "https://gmail.googleapis.com/" }]);
    expect(operations(gmail).filter(({ operation }) => operation.servers)).toEqual([]);
    const list = "/gmail/v1/users/{userId}/messages";
    expect(parameter(gmail, list, "get", "prettyPrint")).toMatchObject({ type: "boolean", default: true });
    expect(parameter(gmail, list, "get", "includeSpamTrash")).toMatchObject({ type: "boolean", default: false });
    expect(parameter(gmail, list, "get", "maxResults")).toMatchObject({ type: "integer", default: 100 });
  });

  test("Drive keeps its media uploads on the root URL of the same host", () => {
    const drive = read("google-drive.json");
    expect(drive.servers).toEqual([{ url: "https://www.googleapis.com/drive/v3/" }]);
    const overridden = operations(drive).filter(({ operation }) => operation.servers);
    expect(overridden.length).toBeGreaterThan(0);
    for (const { path, operation } of overridden) {
      expect(path.startsWith("/upload/")).toBe(true);
      expect(operation.servers).toEqual([{ url: "https://www.googleapis.com/" }]);
    }
  });
});

describe("hostedGoogleSpec", () => {
  const bundle = (paths: JsonObject, schemas: JsonObject = {}): JsonObject => ({
    openapi: "3.1.0",
    info: { title: "Google", version: "google-discovery-bundle" },
    servers: [{ url: "https://www.googleapis.com/" }],
    paths,
    components: { schemas },
  });
  const flag = (value: string) => ({ name: "flag", in: "query", schema: { type: "boolean", default: value } });

  test("moves the document server to where the operations go and types Discovery defaults", () => {
    const hosted = hostedGoogleSpec(
      bundle(
        {
          "/v1/items": {
            get: { servers: [{ url: "https://service.example.com/" }], parameters: [flag("true")] },
          },
          "/upload/v1/items": { post: { servers: [{ url: "https://service.example.com/root/" }] } },
          "/v1/items/{id}": { get: { servers: [{ url: "https://service.example.com/" }] } },
        },
        {
          Item: {
            type: "object",
            properties: {
              count: { type: "integer", default: "5" },
              ratio: { type: "number", default: "0.5" },
              tags: { type: "array", items: { type: "boolean", default: "false" } },
            },
          },
        },
      ),
      "synthetic",
    );
    expect(hosted).toMatchObject({ server: "https://service.example.com/", paths: 3, operations: 3 });
    expect(hosted?.document).toMatchObject({
      servers: [{ url: "https://service.example.com/" }],
      paths: {
        "/v1/items": { get: { parameters: [{ schema: { type: "boolean", default: true } }] } },
        "/upload/v1/items": { post: { servers: [{ url: "https://service.example.com/root/" }] } },
      },
      components: {
        schemas: {
          Item: {
            properties: {
              count: { default: 5 },
              ratio: { default: 0.5 },
              tags: { items: { default: false } },
            },
          },
        },
      },
    });
    expect(hosted?.document.paths).not.toHaveProperty(["/v1/items", "get", "servers"]);
  });

  test("returns undefined for a document with no operations", () => {
    expect(hostedGoogleSpec(bundle({}), "synthetic")).toBeUndefined();
  });

  test("refuses a default that is not its schema's type", () => {
    expect(() =>
      hostedGoogleSpec(bundle({ "/v1/items": { get: { parameters: [flag("yes")] } } }), "synthetic"),
    ).toThrow('default "yes" is not a "boolean"');
  });

  test("refuses a document whose operations span two hosts", () => {
    expect(() =>
      hostedGoogleSpec(
        bundle({
          "/a": { get: { servers: [{ url: "https://a.example.com/" }] } },
          "/b": { get: { servers: [{ url: "https://b.example.com/" }] } },
        }),
        "synthetic",
      ),
    ).toThrow("a hosted document must address one origin");
  });
});
