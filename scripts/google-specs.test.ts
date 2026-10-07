import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HTTP_METHODS,
  googleOperationScopes,
  hostedGoogleSpec,
  parseJsonObject,
  realGooglePaths,
  unlistedDiscoveryScopes,
  type GoogleScopeRules,
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
type Operation = {
  operationId?: string;
  servers?: { url: string }[];
  parameters?: Parameter[];
  security?: Record<string, string[]>[];
  "x-google-scopes"?: string[];
};
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

  test("Gmail reads accept the read-only scope, not only full mail access", () => {
    const gmail = read("google-gmail.json");
    const scopes = (path: string, method: string) =>
      pathsOf(gmail)[path]?.[method]?.["x-google-scopes"];
    const mail = "https://mail.google.com/";
    const gmailScope = (name: string) => `https://www.googleapis.com/auth/gmail.${name}`;
    expect(scopes("/gmail/v1/users/{userId}/messages", "get")).toEqual([
      gmailScope("metadata"),
      gmailScope("modify"),
      gmailScope("readonly"),
      mail,
    ]);
    expect(scopes("/gmail/v1/users/{userId}/messages/send", "post")).toEqual([
      gmailScope("compose"),
      gmailScope("modify"),
      gmailScope("send"),
      mail,
    ]);
    // Google allows permanent deletion only with full mail access.
    expect(scopes("/gmail/v1/users/{userId}/messages/{id}", "delete")).toEqual([mail]);
    for (const { operation } of operations(gmail))
      expect(operation.security).toEqual(
        operation["x-google-scopes"]?.map((scope) => ({ googleOAuth2: [scope] })),
      );
  });

  test("operations list Discovery scopes the consent scopes are not known to cover", () => {
    const scopes = (file: string, operationId: string) =>
      operations(read(file)).find(({ operation }) => operation.operationId === operationId)
        ?.operation["x-google-scopes"];
    const auth = (name: string) => `https://www.googleapis.com/auth/${name}`;
    // Google accepts the narrower chat.messages.create; chat.bot and
    // chat.import, which user consent cannot grant, stay out.
    expect(scopes("google-chat.json", "chat.spaces.messages.create")).toEqual([
      auth("chat.messages"),
      auth("chat.messages.create"),
    ]);
    // Docs reads also accept Drive's per-file and read-only scopes.
    expect(scopes("google-docs.json", "docs.documents.get")).toEqual([
      auth("documents.readonly"),
      auth("documents"),
      auth("drive.file"),
      auth("drive.readonly"),
      auth("drive"),
    ]);
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

describe("googleOperationScopes", () => {
  const full = "https://example.com/full";
  const read = "https://example.com/read";
  const create = "https://example.com/create";
  const settings = "https://example.com/settings";
  const blocked = "https://example.com/blocked";
  const retired = "https://example.com/retired";
  /** Full access is known to cover only `read`; `create` is accepted but no
   *  rule relates it to full access. User consent cannot grant `blocked`, and
   *  the `photos` service's policy no longer admits `retired`. */
  const rules: GoogleScopeRules = {
    methodScopes: (service, _version, scopes) =>
      scopes.length === 0
        ? service === "photos"
          ? [read]
          : scopes
        : scopes.filter((scope) => service !== "photos" || scope !== retired),
    userConsent: (scope) => scope !== blocked,
    covers: (consent, scope) => consent === scope || (consent === full && scope === read),
  };
  const items: JsonObject = {
    name: "items",
    version: "v1",
    auth: {
      oauth2: {
        scopes: {
          [full]: { description: "Everything" },
          [read]: { description: "Read" },
          [create]: { description: "Create" },
          [settings]: { description: "Settings" },
        },
      },
    },
    resources: {
      items: {
        methods: {
          list: { id: "items.list", scopes: [full, read, blocked] },
          insert: { id: "items.insert", scopes: [full, create, blocked] },
          update: { id: "items.update", scopes: [settings] },
          upload: { id: "items.upload", scopes: [full, create] },
        },
      },
    },
  };
  const photos: JsonObject = {
    name: "photos",
    version: "v1",
    resources: {
      photos: {
        methods: {
          list: { id: "photos.list", scopes: [read, retired] },
          pick: { id: "photos.pick" },
        },
      },
    },
  };
  const operation = (operationId: string, scopes: readonly string[]) => ({
    operationId,
    security: scopes.map((scope) => ({ googleOAuth2: [scope] })),
    "x-google-scopes": [...scopes],
  });
  const converted: JsonObject = {
    openapi: "3.1.0",
    paths: {
      "/items": {
        get: operation("items.list", [full]),
        post: operation("items.insert", [full]),
        put: operation("items.update", [settings]),
      },
      "/upload/items": { post: operation("items.uploadMedia", [full]) },
      "/photos": { get: operation("photos.list", [read]), post: operation("photos.pick", [read]) },
      "/synthetic": { post: operation("items.synthetic", [full]) },
    },
    components: {
      securitySchemes: {
        googleOAuth2: {
          type: "oauth2",
          flows: { authorizationCode: { scopes: { [full]: "", [settings]: "", [read]: "" } } },
        },
      },
    },
  };
  const spec = googleOperationScopes(converted, [items, photos], rules, "synthetic");

  test("lists every Discovery scope user consent grants, covered or not", () => {
    const paths = pathsOf(spec);
    // A scope comes after the scopes it covers, otherwise in name order:
    // `create` and full access are unrelated, so they sort by name.
    expect(paths["/items"]?.get).toEqual(operation("items.list", [read, full]));
    expect(paths["/items"]?.post).toEqual(operation("items.insert", [create, full]));
    expect(paths["/items"]?.put).toEqual(operation("items.update", [settings]));
    // A media upload takes the scopes of the method it uploads for.
    expect(paths["/upload/items"]?.post).toEqual(operation("items.uploadMedia", [create, full]));
    // The service's policy decides which Discovery scopes count, and which
    // scopes a method Discovery gives none accepts.
    expect(paths["/photos"]?.get).toEqual(operation("photos.list", [read]));
    expect(paths["/photos"]?.post).toEqual(operation("photos.pick", [read]));
    // No Discovery method: the converted scopes stay.
    expect(paths["/synthetic"]?.post).toEqual(operation("items.synthetic", [full]));
    expect(spec.components).toEqual({
      securitySchemes: {
        googleOAuth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              scopes: {
                [full]: "Everything",
                [settings]: "Settings",
                [read]: "Read",
                [create]: "Create",
              },
            },
          },
        },
      },
    });
  });

  test("leaves no scope Google accepts unlisted, and finds one that is", () => {
    expect(unlistedDiscoveryScopes(spec, [items, photos], rules, "synthetic")).toEqual([]);
    // The converter's own output omits what the coverage rule does not know.
    expect(unlistedDiscoveryScopes(converted, [items, photos], rules, "synthetic")).toEqual([
      "get /items: https://example.com/read",
      "post /items: https://example.com/create",
      "post /upload/items: https://example.com/create",
    ]);
  });

  test("refuses scopes that cover each other", () => {
    const loose = { ...rules, covers: () => true };
    expect(() => googleOperationScopes(converted, [items, photos], loose, "synthetic")).toThrow(
      "cover each other",
    );
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

  test("refuses a security requirement whose scope the OAuth scheme does not declare", () => {
    expect(() =>
      hostedGoogleSpec(
        {
          ...bundle({ "/v1/items": { get: { security: [{ googleOAuth2: ["https://example.com/read"] }] } } }),
          components: {
            securitySchemes: {
              googleOAuth2: { type: "oauth2", flows: { authorizationCode: { scopes: {} } } },
            },
          },
        },
        "synthetic",
      ),
    ).toThrow('googleOAuth2 does not declare the scope "https://example.com/read"');
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
