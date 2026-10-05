/**
 * Turns executor's Google Discovery bundle conversion into a standalone OpenAPI
 * document that integrations.sh can host.
 *
 * The bundle converter is built for documents that span several Google
 * services, and two of its choices are wrong for a document that describes one:
 *
 * - It declares https://www.googleapis.com/ as the document server and pins
 *   every operation to its real service endpoint (gmail.googleapis.com, …) with
 *   an operation-level server. Importers that read the document server, or that
 *   hold one API's credential to a single origin, then call a host no operation
 *   uses.
 * - It copies Discovery defaults verbatim, and Discovery encodes every default
 *   as a string, so a boolean parameter declares `default: "true"`.
 *
 * `hostedGoogleSpec` rewrites both. Generation and the committed-spec test use
 * the same function, so a regenerated spec cannot reintroduce either mistake.
 */

/** A parsed JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A parsed JSON object. */
export type JsonObject = { [key: string]: Json };

/** The OpenAPI path-item keys that hold Operation Objects. */
export const HTTP_METHODS: ReadonlySet<string> = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

/** Whether a JSON value is an object (not an array or null). */
export const isJsonObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parses a JSON document whose root must be an object.
 *
 * @throws when the text is not JSON or its root is not an object; generation
 * cannot continue from a converter that produced either.
 */
export function parseJsonObject(text: string, at: string): JsonObject {
  // SAFETY: JSON.parse only produces null, booleans, numbers, strings, arrays
  // and plain objects, which is exactly the Json union.
  const value = JSON.parse(text) as Json;
  if (!isJsonObject(value)) throw new Error(`${at}: expected a JSON object`);
  return value;
}

/** A converted Google service document, ready to host. */
export interface HostedGoogleSpec {
  readonly document: JsonObject;
  /** The document server: the URL most of its operations are sent to. */
  readonly server: string;
  readonly paths: number;
  readonly operations: number;
}

/**
 * Normalizes one converted Google service document for hosting, or returns
 * undefined when it has no operations (executor's service policy can strip
 * every method of a service). `at` names the document in failure messages. The
 * input is not modified.
 *
 * - The document server becomes the URL most operations are sent to. An
 *   operation sent elsewhere (a media upload on the service's root URL) keeps
 *   its own server, and every other server override is removed.
 * - Every schema default takes the schema's declared type.
 *
 * @throws when the operations span more than one origin, or when a default
 * cannot be read as its schema's type. Either is a change in Google's documents
 * or executor's converter that a person must look at, not something to publish.
 */
export function hostedGoogleSpec(spec: JsonObject, at: string): HostedGoogleSpec | undefined {
  const routed = withOperationServer(spec, at);
  if (routed === undefined) return undefined;
  return { ...routed, document: withTypedDefaults(routed.document, at) };
}

function singleServerUrl(servers: Json | undefined, at: string): string | undefined {
  if (servers === undefined) return undefined;
  if (!Array.isArray(servers) || servers.length !== 1)
    throw new Error(`${at}: expected exactly one server`);
  const [server] = servers;
  if (!isJsonObject(server) || typeof server.url !== "string")
    throw new Error(`${at}: server has no url`);
  return server.url;
}

const objectAt = (value: Json | undefined, at: string): JsonObject => {
  if (!isJsonObject(value)) throw new Error(`${at}: expected an object`);
  return value;
};

const withoutServers = (value: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== "servers"));

/** Each operation of a path item with the URL it is sent to: its own server,
 *  else its path item's, else the document's. */
function operationRoutes(
  item: JsonObject,
  documentUrl: string | undefined,
  at: string,
): readonly { readonly method: string; readonly operation: JsonObject; readonly url: string }[] {
  const itemUrl = singleServerUrl(item.servers, `${at} servers`) ?? documentUrl;
  return Object.entries(item).flatMap(([method, value]) => {
    if (!HTTP_METHODS.has(method)) return [];
    const where = `${at} ${method}`;
    const operation = objectAt(value, where);
    const url = singleServerUrl(operation.servers, `${where} servers`) ?? itemUrl;
    if (url === undefined) throw new Error(`${where}: no server`);
    return [{ method, operation, url }];
  });
}

function withOperationServer(
  spec: JsonObject,
  at: string,
): HostedGoogleSpec | undefined {
  const paths = objectAt(spec.paths, `${at} paths`);
  const documentUrl = singleServerUrl(spec.servers, `${at} servers`);
  const items = Object.entries(paths).map(([path, value]) => {
    const item = objectAt(value, `${at} ${path}`);
    return { path, item, routes: operationRoutes(item, documentUrl, `${at} ${path}`) };
  });

  const counts = new Map<string, number>();
  for (const { url } of items.flatMap((item) => item.routes))
    counts.set(url, (counts.get(url) ?? 0) + 1);
  let server: string | undefined;
  let serverCount = 0;
  for (const [url, count] of counts) {
    if (count > serverCount) [server, serverCount] = [url, count];
  }
  if (server === undefined) return undefined;
  const origins = new Set([...counts.keys()].map((url) => new URL(url).origin));
  if (origins.size > 1)
    throw new Error(
      `${at}: operations are sent to ${[...origins].join(", ")}; a hosted document must address one origin`,
    );

  const rewritten = Object.fromEntries(
    items.map(({ path, item, routes }) => [
      path,
      Object.fromEntries([
        ...Object.entries(withoutServers(item)).filter(([key]) => !HTTP_METHODS.has(key)),
        ...routes.map(({ method, operation, url }): [string, Json] => [
          method,
          url === server
            ? withoutServers(operation)
            : { ...withoutServers(operation), servers: [{ url }] },
        ]),
      ]),
    ]),
  );

  return {
    document: { ...spec, servers: [{ url: server }], paths: rewritten },
    server,
    paths: items.length,
    operations: [...counts.values()].reduce((sum, count) => sum + count, 0),
  };
}

// JSON Schema keywords whose values are schemas, maps of schemas, or lists of
// schemas. Every other keyword's value is data and is left alone.
const SUBSCHEMA = new Set([
  "items",
  "additionalProperties",
  "not",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SUBSCHEMA_MAP = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
const SUBSCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

const mapValues = (value: JsonObject, f: (value: Json, key: string) => Json): JsonObject =>
  Object.fromEntries(Object.entries(value).map(([key, item]) => [key, f(item, key)]));

const hasType = (type: Json | undefined, value: Json): boolean => {
  if (type === undefined) return true;
  if (Array.isArray(type)) return type.some((each) => hasType(each, value));
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
    case "null":
      return value === null;
    default:
      throw new Error(`unknown schema type ${JSON.stringify(type)}`);
  }
};

/** Discovery's string encoding of a scalar default, read as `type`. */
function discoveryScalar(type: Json | undefined, value: string): Json | undefined {
  switch (type) {
    case "boolean":
      return value === "true" ? true : value === "false" ? false : undefined;
    case "integer": {
      const parsed = Number(value);
      return /^-?\d+$/.test(value) && Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    case "number": {
      const parsed = Number(value);
      return value.trim() !== "" && Number.isFinite(parsed) ? parsed : undefined;
    }
    default:
      return undefined;
  }
}

function typedSchema(schema: Json, at: string): Json {
  if (!isJsonObject(schema)) return schema;
  const typed = mapValues(schema, (value, key) => {
    const where = `${at}/${key}`;
    if (SUBSCHEMA.has(key)) return typedSchema(value, where);
    if (SUBSCHEMA_MAP.has(key) && isJsonObject(value))
      return mapValues(value, (each, name) => typedSchema(each, `${where}/${name}`));
    if (SUBSCHEMA_LIST.has(key) && Array.isArray(value))
      return value.map((each, index) => typedSchema(each, `${where}/${index}`));
    return value;
  });
  const value = schema.default;
  if (value === undefined || hasType(schema.type, value)) return typed;
  const parsed = typeof value === "string" ? discoveryScalar(schema.type, value) : undefined;
  if (parsed === undefined)
    throw new Error(
      `${at}: default ${JSON.stringify(value)} is not a ${JSON.stringify(schema.type)}`,
    );
  return { ...typed, default: parsed };
}

/** A Parameter or Media Type Object: its schema lives under `schema`. */
const typedSchemaField = (value: Json, at: string): Json =>
  isJsonObject(value)
    ? mapValues(value, (field, key) => (key === "schema" ? typedSchema(field, `${at}/schema`) : field))
    : value;

const typedParameters = (parameters: Json, at: string): Json =>
  Array.isArray(parameters)
    ? parameters.map((parameter, index) => typedSchemaField(parameter, `${at}/${index}`))
    : parameters;

/** A Request Body or Response Object: its schemas live under `content`. */
const typedBody = (body: Json, at: string): Json =>
  isJsonObject(body)
    ? mapValues(body, (value, key) =>
        key === "content" && isJsonObject(value)
          ? mapValues(value, (media, type) => typedSchemaField(media, `${at}/content/${type}`))
          : value,
      )
    : body;

const typedOperation = (operation: Json, at: string): Json =>
  isJsonObject(operation)
    ? mapValues(operation, (value, key) => {
        switch (key) {
          case "parameters":
            return typedParameters(value, `${at}/parameters`);
          case "requestBody":
            return typedBody(value, `${at}/requestBody`);
          case "responses":
            return isJsonObject(value)
              ? mapValues(value, (response, status) =>
                  typedBody(response, `${at}/responses/${status}`),
                )
              : value;
          default:
            return value;
        }
      })
    : operation;

function withTypedDefaults(spec: JsonObject, at: string): JsonObject {
  const paths = objectAt(spec.paths, `${at} paths`);
  const components = spec.components;
  return {
    ...spec,
    paths: mapValues(paths, (item, path) => {
      const where = `${at} #/paths/${path}`;
      return isJsonObject(item)
        ? mapValues(item, (value, key) =>
            key === "parameters"
              ? typedParameters(value, `${where}/parameters`)
              : HTTP_METHODS.has(key)
                ? typedOperation(value, `${where}/${key}`)
                : value,
          )
        : item;
    }),
    ...(isJsonObject(components) && isJsonObject(components.schemas)
      ? {
          components: {
            ...components,
            schemas: mapValues(components.schemas, (schema, name) =>
              typedSchema(schema, `${at} #/components/schemas/${name}`),
            ),
          },
        }
      : {}),
  };
}
