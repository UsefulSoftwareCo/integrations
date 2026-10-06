import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HTTP_METHODS,
  hostedGoogleSpec,
  parseJsonObject,
  realGooglePaths,
  type Json,
  type JsonObject,
} from "./google-specs.ts";

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "specs", "google");
const files = readdirSync(SPECS).filter((file) => file.startsWith("google-") && file.endsWith(".json"));
const text = (file: string): string => readFileSync(join(SPECS, file), "utf8");
const read = (file: string): JsonObject => parseJsonObject(text(file), file);

type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  allowReserved?: boolean;
  schema: JsonObject;
};
type Operation = { operationId?: string; servers?: { url: string }[]; parameters?: Parameter[] };
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
/** Each operation's method and path, by operation id. */
const routes = (spec: JsonObject) =>
  Object.fromEntries(
    operations(spec).map(({ path, method, operation }) => [
      operation.operationId,
      `${method.toUpperCase()} ${path}`,
    ]),
  );
const pathParameters = (spec: JsonObject, path: string, method: string) =>
  pathsOf(spec)[path]?.[method]?.parameters?.filter((each) => each.in === "path");

describe("hosted Google specs", () => {
  test("every committed spec is already in its hosted form", () => {
    expect(files.length).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(join(SPECS, "manifest.json"), "utf8")) as {
      specs: Record<string, { server: string; operations: number }>;
    };
    for (const file of files) {
      const hosted = hostedGoogleSpec(read(file), file);
      // Byte for byte: hosting a hosted spec changes nothing, not even its order.
      expect(JSON.stringify(hosted?.document)).toBe(text(file));
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

  test("People splits only the methods that share GET /v1/{+resourceName}", () => {
    const people = read("google-people.json");
    expect(routes(people)).toMatchObject({
      "people.people.get": "GET /v1/people/{peopleId}",
      "people.contactGroups.get": "GET /v1/contactGroups/{contactGroupsId}",
      "people.contactGroups.update": "PUT /v1/{resourceName}",
      "people.people.updateContact": "PATCH /v1/{resourceName}:updateContact",
    });
    expect(pathParameters(people, "/v1/contactGroups/{contactGroupsId}", "get")).toMatchObject([
      { name: "contactGroupsId", in: "path", allowReserved: true },
    ]);
    const [resourceName] = pathParameters(people, "/v1/{resourceName}:updateContact", "patch") ?? [];
    expect(resourceName).toMatchObject({ name: "resourceName", in: "path", allowReserved: true });
    expect(resourceName?.description).toStartWith("The resource name for the person");
  });

  test("Chat splits only the methods that share a method and template", () => {
    const chat = read("google-chat.json");
    expect(routes(chat)).toMatchObject({
      "chat.spaces.get": "GET /v1/spaces/{spacesId}",
      "chat.spaces.messages.get": "GET /v1/spaces/{spacesId}/messages/{messagesId}",
      "chat.spaces.members.get": "GET /v1/spaces/{spacesId}/members/{membersId}",
      "chat.users.spaces.getSpaceReadState": "GET /v1/users/{usersId}/spaces/{spacesId}/spaceReadState",
      "chat.spaces.messages.update": "PUT /v1/{name}",
      "chat.spaces.messages.list": "GET /v1/{parent}/messages",
      "chat.media.uploadMedia": "POST /upload/v1/{parent}/attachments:upload",
    });
  });
});

describe("realGooglePaths", () => {
  type DiscoveryMethod = {
    id: string;
    path: string;
    httpMethod: string;
    parameters: Record<string, { location: string; pattern?: string }>;
    upload?: string;
  };
  const discoveryDocument = (methods: readonly DiscoveryMethod[]): JsonObject => ({
    name: "example",
    resources: Object.fromEntries(
      methods.map(({ id, path, httpMethod, parameters, upload }) => [
        id,
        {
          methods: {
            [httpMethod]: {
              id,
              path,
              httpMethod,
              parameters,
              ...(upload ? { mediaUpload: { protocols: { simple: { path: upload } } } } : {}),
            },
          },
        },
      ]),
    ),
  });
  /** What executor's bundle converter does with these methods: the first
   *  method on a path gets it and every later one a placeholder. */
  const converted = (methods: readonly DiscoveryMethod[]): JsonObject => {
    const paths: Record<string, Record<string, Json>> = {};
    const add = (id: string, method: string, template: string, parameters: Json[]) => {
      const preferred = template.replaceAll(/\{\+([^{}]+)\}/g, "{$1}");
      const path = paths[preferred]?.[method] ? `/${id}` : preferred;
      (paths[path] ??= {})[method] = {
        operationId: id,
        "x-executor-pathTemplate": template,
        parameters,
      };
    };
    for (const { id, path, httpMethod, parameters, upload } of methods) {
      const converted = Object.entries(parameters).map(([name, { location }]) => ({
        name,
        in: location,
        required: true,
        description: `The ${name}.`,
        schema: { description: `The ${name}.`, type: "string" },
        ...(`${path} ${upload}`.includes(`{+${name}}`) ? { allowReserved: true } : {}),
      }));
      add(id, httpMethod.toLowerCase(), `/${path}`, converted);
      if (upload) add(`${id}Media`, httpMethod.toLowerCase(), upload, converted);
    }
    return {
      openapi: "3.1.0",
      info: { title: "Google", version: "google-discovery-bundle" },
      servers: [{ url: "https://example.googleapis.com/" }],
      paths,
    };
  };
  const real = (methods: readonly DiscoveryMethod[]) =>
    realGooglePaths(converted(methods), [discoveryDocument(methods)], "synthetic");

  const people: DiscoveryMethod = {
    id: "people.people.get",
    path: "v1/{+resourceName}",
    httpMethod: "GET",
    parameters: { resourceName: { location: "path", pattern: "^people/[^/]+$" } },
  };
  const contactGroups: DiscoveryMethod = {
    id: "people.contactGroups.get",
    path: "v1/{+resourceName}",
    httpMethod: "GET",
    parameters: { resourceName: { location: "path", pattern: "^contactGroups/[^/]+$" } },
  };

  test("splits a shared template by each method's pattern, whatever the document order", () => {
    const forward = hostedGoogleSpec(real([people, contactGroups]), "synthetic");
    const backward = hostedGoogleSpec(real([contactGroups, people]), "synthetic");
    expect(JSON.stringify(backward?.document)).toBe(JSON.stringify(forward?.document));
    const document = forward!.document;
    expect(routes(document)).toEqual({
      "people.people.get": "GET /v1/people/{peopleId}",
      "people.contactGroups.get": "GET /v1/contactGroups/{contactGroupsId}",
    });
    expect(pathParameters(document, "/v1/people/{peopleId}", "get")).toEqual([
      {
        name: "peopleId",
        in: "path",
        required: true,
        description: "`peopleId` of `resourceName` (`people/{peopleId}`). The resourceName.",
        schema: {
          description: "`peopleId` of `resourceName` (`people/{peopleId}`). The resourceName.",
          type: "string",
        },
        allowReserved: true,
      },
    ]);
    expect(JSON.stringify(document)).not.toContain("x-executor-pathTemplate");
  });

  test("keeps a template no other operation shares with its whole resource name", () => {
    const message = (id: string, httpMethod: string): DiscoveryMethod => ({
      id,
      path: "v1/{+name}",
      httpMethod,
      parameters: { name: { location: "path", pattern: "^spaces/[^/]+/messages/[^/]+$" } },
    });
    const document = real([
      // Another method on the same template is not a shared route.
      message("chat.spaces.messages.get", "GET"),
      message("chat.spaces.messages.delete", "DELETE"),
      {
        id: "chat.media.upload",
        path: "v1/{+parent}/attachments:upload",
        httpMethod: "POST",
        parameters: { parent: { location: "path", pattern: "^spaces/[^/]+$" } },
        upload: "/upload/v1/{+parent}/attachments:upload",
      },
    ]);
    expect(routes(document)).toEqual({
      "chat.spaces.messages.get": "GET /v1/{name}",
      "chat.spaces.messages.delete": "DELETE /v1/{name}",
      "chat.media.upload": "POST /v1/{parent}/attachments:upload",
      "chat.media.uploadMedia": "POST /upload/v1/{parent}/attachments:upload",
    });
    expect(pathParameters(document, "/v1/{name}", "get")).toEqual([
      {
        name: "name",
        in: "path",
        required: true,
        description: "The name.",
        schema: { description: "The name.", type: "string" },
        allowReserved: true,
      },
    ]);
    expect(JSON.stringify(document)).not.toContain("x-executor-pathTemplate");
  });

  test("names every segment of a shared template and keeps one-wildcard patterns", () => {
    const document = real([
      {
        id: "chat.spaces.get",
        path: "v1/{+name}",
        httpMethod: "GET",
        parameters: { name: { location: "path", pattern: "^spaces/[^/]+$" } },
      },
      {
        id: "chat.spaces.messages.get",
        path: "v1/{+name}",
        httpMethod: "GET",
        parameters: { name: { location: "path", pattern: "^spaces/[^/]+/messages/[^/]+$" } },
      },
      // Its `{+resourceName}` matches the same requests as `{+name}`.
      people,
      {
        id: "crm.operations.get",
        path: "v3/{+name}",
        httpMethod: "GET",
        parameters: { name: { location: "path", pattern: "^operations/.*$" } },
      },
      {
        id: "crm.folders.get",
        path: "v3/{+name}",
        httpMethod: "GET",
        parameters: { name: { location: "path", pattern: "^[^/]+$" } },
      },
    ]);
    expect(routes(document)).toEqual({
      "chat.spaces.get": "GET /v1/spaces/{spacesId}",
      "chat.spaces.messages.get": "GET /v1/spaces/{spacesId}/messages/{messagesId}",
      "people.people.get": "GET /v1/people/{peopleId}",
      "crm.operations.get": "GET /v3/operations/{operationsId}",
      "crm.folders.get": "GET /v3/{name}",
    });
    expect(
      pathParameters(document, "/v1/spaces/{spacesId}/messages/{messagesId}", "get"),
    ).toMatchObject([
      {
        name: "spacesId",
        description: "`spacesId` of `name` (`spaces/{spacesId}/messages/{messagesId}`). The name.",
        allowReserved: true,
      },
      {
        name: "messagesId",
        description: "`messagesId` of `name` (`spaces/{spacesId}/messages/{messagesId}`). The name.",
        allowReserved: true,
      },
    ]);
    expect(pathParameters(document, "/v3/operations/{operationsId}", "get")).toMatchObject([
      { name: "operationsId", allowReserved: true },
    ]);
    expect(pathParameters(document, "/v3/{name}", "get")).toMatchObject([
      { name: "name", description: "The name.", allowReserved: true },
    ]);
  });

  test("resolves the Discovery method of a shared media upload", () => {
    const upload = (id: string, parent: string): DiscoveryMethod => ({
      id,
      path: "v1/{+parent}/attachments:upload",
      httpMethod: "POST",
      parameters: { parent: { location: "path", pattern: `^${parent}/[^/]+$` } },
      upload: "/upload/v1/{+parent}/attachments:upload",
    });
    const document = real([upload("chat.media.upload", "spaces"), upload("chat.users.upload", "users")]);
    expect(routes(document)).toEqual({
      "chat.media.upload": "POST /v1/spaces/{spacesId}/attachments:upload",
      "chat.media.uploadMedia": "POST /upload/v1/spaces/{spacesId}/attachments:upload",
      "chat.users.upload": "POST /v1/users/{usersId}/attachments:upload",
      "chat.users.uploadMedia": "POST /upload/v1/users/{usersId}/attachments:upload",
    });
  });

  test("refuses a shared template's pattern that is not a resource-name path", () => {
    expect(() =>
      real([
        {
          ...people,
          parameters: { resourceName: { location: "path", pattern: "^people/\\d+$" } },
        },
        contactGroups,
      ]),
    ).toThrow('unsupported pattern "^people/\\\\d+$"');
  });

  test("refuses two methods that would still share a route", () => {
    expect(() => real([people, { ...people, id: "people.people.read" }])).toThrow(
      "are the same GET route",
    );
    // Paths that differ only in parameter names match the same requests.
    expect(() =>
      real([
        people,
        contactGroups,
        {
          id: "people.people.lookup",
          path: "v1/people/{+personId}",
          httpMethod: "GET",
          parameters: { personId: { location: "path", pattern: "^[^/]+$" } },
        },
      ]),
    ).toThrow("are the same GET route");
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
  const id = { name: "id", in: "path", required: true, schema: { type: "string" } };

  test("moves the document server to where the operations go and types Discovery defaults", () => {
    const hosted = hostedGoogleSpec(
      bundle(
        {
          "/v1/items": {
            get: { servers: [{ url: "https://service.example.com/" }], parameters: [flag("true")] },
          },
          "/upload/v1/items": { post: { servers: [{ url: "https://service.example.com/root/" }] } },
          "/v1/items/{id}": {
            get: { servers: [{ url: "https://service.example.com/" }], parameters: [id] },
          },
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

  test("refuses an operation that is not on its real path", () => {
    const hosted = (paths: JsonObject) => () => hostedGoogleSpec(bundle(paths), "synthetic");
    expect(
      hosted({ "/people.contactGroups.get": { get: { operationId: "people.contactGroups.get" } } }),
    ).toThrow("people.contactGroups.get has a placeholder path");
    expect(
      hosted({ "/v1/{id}": { get: { "x-executor-pathTemplate": "/v1/{+id}", parameters: [id] } } }),
    ).toThrow("run realGooglePaths first");
    expect(hosted({ "/v1/items/{id}": { get: {} } })).toThrow(
      'the path names {id} but the operation declares []',
    );
  });
});
