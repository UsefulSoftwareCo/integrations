/**
 * Turns executor's Google Discovery bundle conversion into a standalone OpenAPI
 * document that integrations.sh can host.
 *
 * The bundle converter is built for documents that span several Google
 * services, and some of its choices are wrong for a document that describes one:
 *
 * - It keys each operation by its Discovery path with `{+name}` written as
 *   `{name}`. Google routes many methods through one template such as
 *   `/v1/{+resourceName}` and tells them apart by the parameter's pattern
 *   (`^people/[^/]+$`, `^contactGroups/[^/]+$`). OpenAPI allows one operation
 *   per path and method, so the converter gives the shared path to whichever
 *   method it reads first and keys the rest by a placeholder such as
 *   `/people.contactGroups.get`. The real template survives only in
 *   `x-executor-pathTemplate`, and Discovery lists methods in a different order
 *   on every fetch.
 * - It declares https://www.googleapis.com/ as the document server and pins
 *   every operation to its real service endpoint (gmail.googleapis.com, …) with
 *   an operation-level server. Importers that read the document server, or that
 *   hold one API's credential to a single origin, then call a host no operation
 *   uses.
 * - It copies Discovery defaults verbatim, and Discovery encodes every default
 *   as a string, so a boolean parameter declares `default: "true"`.
 * - It writes paths, schemas, properties and parameters in Discovery's order,
 *   which changes on every fetch.
 *
 * `realGooglePaths` keys every operation by its real path, built from its
 * Discovery template and its parameters' patterns. It needs the Discovery
 * documents, so only generation runs it. `hostedGoogleSpec` rewrites the rest
 * and refuses an operation whose path is not real. Generation and the
 * committed-spec test both run `hostedGoogleSpec`, so a regenerated spec cannot
 * reintroduce any of these mistakes.
 */

/** A parsed JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A parsed JSON object. */
export type JsonObject = { [key: string]: Json };

/** The OpenAPI path-item keys that hold Operation Objects, in canonical order. */
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

const objectAt = (value: Json | undefined, at: string): JsonObject => {
  if (!isJsonObject(value)) throw new Error(`${at}: expected an object`);
  return value;
};

const arrayAt = (value: Json | undefined, at: string): Json[] => {
  if (!Array.isArray(value)) throw new Error(`${at}: expected an array`);
  return value;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const PATH_TEMPLATE = "x-executor-pathTemplate";
/** RFC 6570 reserved expansion, which Discovery uses for resource names. */
const RESERVED_EXPANSION = /\{\+([^{}]+)\}/g;
const PATH_PARAMETER = /\{([^{}]+)\}/g;

// ---------------------------------------------------------------------------
// Real paths
// ---------------------------------------------------------------------------

/** Every method of the Discovery documents, by id. */
function discoveryMethods(
  discovery: readonly JsonObject[],
  at: string,
): ReadonlyMap<string, JsonObject> {
  const methods = new Map<string, JsonObject>();
  const visit = (resource: JsonObject, where: string): void => {
    // Discovery omits `methods` and `resources` when a resource has none.
    if (resource.methods !== undefined)
      for (const [name, value] of Object.entries(objectAt(resource.methods, `${where} methods`))) {
        const method = objectAt(value, `${where} method ${name}`);
        if (typeof method.id !== "string") throw new Error(`${where} method ${name}: no id`);
        if (methods.has(method.id))
          throw new Error(`${at}: Discovery method ${method.id} appears twice`);
        methods.set(method.id, method);
      }
    if (resource.resources !== undefined)
      for (const [name, value] of Object.entries(
        objectAt(resource.resources, `${where} resources`),
      ))
        visit(objectAt(value, `${where}.${name}`), `${where}.${name}`);
  };
  discovery.forEach((document, index) => visit(document, `${at} Discovery document ${index}`));
  return methods;
}

/** The path templates a Discovery method's operations are converted with: its
 *  own path, and its simple media upload path when it has one. */
function wireTemplates(method: JsonObject): readonly string[] {
  const own =
    typeof method.path === "string"
      ? [method.path.startsWith("/") ? method.path : `/${method.path}`]
      : [];
  const protocols = isJsonObject(method.mediaUpload) ? method.mediaUpload.protocols : undefined;
  const simple = isJsonObject(protocols) ? protocols.simple : undefined;
  const upload = isJsonObject(simple) && typeof simple.path === "string" ? [simple.path] : [];
  return [...own, ...upload];
}

/** The Discovery method an operation was converted from. The converter names a
 *  method's operation by the method id, and its media upload `${id}Media`. */
function discoveryMethodFor(
  operation: JsonObject,
  template: string,
  methods: ReadonlyMap<string, JsonObject>,
  where: string,
): JsonObject {
  const id = operation.operationId;
  if (typeof id !== "string") throw new Error(`${where}: no operationId`);
  const media = "Media";
  const candidates = [
    methods.get(id),
    id.endsWith(media) ? methods.get(id.slice(0, -media.length)) : undefined,
  ];
  const method = candidates.find(
    (candidate) => candidate !== undefined && wireTemplates(candidate).includes(template),
  );
  if (method === undefined)
    throw new Error(`${where}: no Discovery method ${id} with path ${template}`);
  return method;
}

type PatternPart =
  | { readonly literal: string }
  | { readonly wildcard: "segment" | "rest" };

/**
 * Reads a Discovery parameter pattern as path segments. Google's resource-name
 * patterns are `^` + segments joined by `/` + `$`, where a segment is a literal,
 * `[^/]+` (one segment) or a final `.*` (the rest of the path).
 */
function patternParts(pattern: string, where: string): readonly PatternPart[] {
  const unsupported = () => new Error(`${where}: unsupported pattern ${JSON.stringify(pattern)}`);
  const body = /^\^(.+)\$$/.exec(pattern)?.[1];
  if (body === undefined) throw unsupported();
  const parts: PatternPart[] = [];
  let remaining = body;
  for (;;) {
    const match = /^(\[\^\/\]\+|\.\*|[A-Za-z][A-Za-z0-9_-]*)(\/|$)/.exec(remaining);
    if (match === null) throw unsupported();
    const [whole, part, separator] = match;
    parts.push(
      part === "[^/]+"
        ? { wildcard: "segment" }
        : part === ".*"
          ? { wildcard: "rest" }
          : { literal: part! },
    );
    if (separator === "") return parts;
    // `.*` takes the rest of the path, so nothing may follow it.
    if (part === ".*") throw unsupported();
    remaining = remaining.slice(whole.length);
  }
}

/**
 * Replaces a reserved-expansion path parameter with the path its pattern
 * describes. A parameter whose pattern is one wildcard (`^[^/]+$`, `^.*$`)
 * stays as it is. Otherwise each wildcard becomes its own parameter, named
 * after the literal before it as Discovery's `flatPath` does: `name` with
 * `^spaces/[^/]+/messages/[^/]+$` becomes `spaces/{spacesId}/messages/{messagesId}`.
 * The new parameters keep the original's location, schema and reserved
 * expansion, so a valid value is sent exactly as before.
 */
function expandReserved(
  parameter: JsonObject,
  pattern: string,
  where: string,
): { readonly fragment: string; readonly parameters: readonly JsonObject[] } {
  const name = parameter.name;
  if (typeof name !== "string") throw new Error(`${where}: parameter has no name`);
  const parts = patternParts(pattern, where);
  const [only] = parts;
  if (parts.length === 1 && only !== undefined && "wildcard" in only)
    return { fragment: `{${name}}`, parameters: [parameter] };

  const form = parts
    .map((part, index) => {
      if ("literal" in part) return part.literal;
      const previous = parts[index - 1];
      if (previous === undefined || !("literal" in previous))
        throw new Error(`${where}: pattern ${JSON.stringify(pattern)} has an unnamed wildcard`);
      return `{${previous.literal}Id}`;
    })
    .join("/");
  const schema = objectAt(parameter.schema, `${where} schema`);
  const original = typeof parameter.description === "string" ? ` ${parameter.description}` : "";
  return {
    fragment: form,
    parameters: [...form.matchAll(PATH_PARAMETER)].map(([, segment]) => {
      const description = `\`${segment}\` of \`${name}\` (\`${form}\`).${original}`;
      return { ...parameter, name: segment!, description, schema: { ...schema, description } };
    }),
  };
}

/** One converted operation keyed by its real path, without the template. */
function realOperation(
  operation: JsonObject,
  methods: ReadonlyMap<string, JsonObject>,
  where: string,
): { readonly path: string; readonly operation: JsonObject } {
  const { [PATH_TEMPLATE]: template, ...rest } = operation;
  if (typeof template !== "string" || !template.startsWith("/"))
    throw new Error(`${where}: expected an absolute ${PATH_TEMPLATE}`);
  const reserved = [...template.matchAll(RESERVED_EXPANSION)].map(([, name]) => name!);
  if (reserved.length === 0) return { path: template, operation: rest };

  const method = discoveryMethodFor(operation, template, methods, where);
  const discoveryParameters = objectAt(method.parameters, `${where} Discovery parameters`);
  let path = template;
  let parameters = arrayAt(operation.parameters, `${where} parameters`);
  for (const name of reserved) {
    const pattern = objectAt(
      discoveryParameters[name],
      `${where} Discovery parameter ${name}`,
    ).pattern;
    if (typeof pattern !== "string")
      throw new Error(`${where}: Discovery parameter ${name} has no pattern`);
    const index = parameters.findIndex(
      (parameter) => isJsonObject(parameter) && parameter.in === "path" && parameter.name === name,
    );
    if (index < 0) throw new Error(`${where}: no path parameter ${name}`);
    const expansion = expandReserved(
      objectAt(parameters[index], `${where} path parameter ${name}`),
      pattern,
      `${where} ${name}`,
    );
    path = path.replace(`{+${name}}`, () => expansion.fragment);
    parameters = [
      ...parameters.slice(0, index),
      ...expansion.parameters,
      ...parameters.slice(index + 1),
    ];
  }
  const names = parameters.map((parameter) => objectAt(parameter, `${where} parameter`).name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined)
    throw new Error(`${where}: ${path} declares parameter ${JSON.stringify(repeated)} twice`);
  return { path, operation: { ...rest, parameters } };
}

/**
 * Keys every operation of a converted Google bundle by the path it is sent to,
 * built from its Discovery path template and its path parameters' Discovery
 * patterns (see `expandReserved`), and drops `x-executor-pathTemplate`, which
 * the path now states. Each path depends only on its own method, so the result
 * is the same whatever order the Discovery documents list methods in.
 * `discovery` holds the documents the spec was converted from. The input is not
 * modified.
 *
 * @throws when an operation has no template or Discovery method, when a
 * pattern is not a path Google's resource names use, or when two operations
 * would still share a method and a path (ignoring parameter names).
 */
export function realGooglePaths(
  spec: JsonObject,
  discovery: readonly JsonObject[],
  at: string,
): JsonObject {
  const methods = discoveryMethods(discovery, at);
  const paths: Record<string, JsonObject> = {};
  // A request matches paths that differ only in parameter names equally well.
  const routes = new Map<string, { readonly path: string; readonly id: Json | undefined }>();
  for (const [key, value] of Object.entries(objectAt(spec.paths, `${at} paths`))) {
    for (const [method, operation] of Object.entries(objectAt(value, `${at} ${key}`))) {
      const where = `${at} ${method} ${key}`;
      if (!HTTP_METHODS.has(method)) throw new Error(`${where}: unexpected path item field`);
      const real = realOperation(objectAt(operation, where), methods, where);
      const route = `${method} ${real.path.replace(PATH_PARAMETER, "{}")}`;
      const existing = routes.get(route);
      if (existing !== undefined) {
        const first = `${JSON.stringify(existing.id)} (${existing.path})`;
        const second = `${JSON.stringify(real.operation.operationId)} (${real.path})`;
        throw new Error(`${at}: ${first} and ${second} are the same ${method.toUpperCase()} route`);
      }
      routes.set(route, { path: real.path, id: real.operation.operationId });
      (paths[real.path] ??= {})[method] = real.operation;
    }
  }
  return { ...spec, paths };
}

// ---------------------------------------------------------------------------
// Hosted form
// ---------------------------------------------------------------------------

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
 * every method of a service). Run `realGooglePaths` first. `at` names the
 * document in failure messages. The input is not modified.
 *
 * - The document server becomes the URL most operations are sent to. An
 *   operation sent elsewhere (a media upload on the service's root URL) keeps
 *   its own server, and every other server override is removed.
 * - Every schema default takes the schema's declared type.
 * - Paths, methods, schemas, properties and parameters are written in a fixed
 *   order, so the same service always produces the same document.
 *
 * @throws when an operation is not keyed by a real path, when the operations
 * span more than one origin, or when a default cannot be read as its schema's
 * type. Each is a change in Google's documents or executor's converter that a
 * person must look at, not something to publish.
 */
export function hostedGoogleSpec(spec: JsonObject, at: string): HostedGoogleSpec | undefined {
  assertRealPaths(spec, at);
  const routed = withOperationServer(spec, at);
  if (routed === undefined) return undefined;
  const schemas = withSchemas(routed.document, at, (schema, where) =>
    withSortedProperties(withTypedDefault(schema, where)),
  );
  return { ...routed, document: inCanonicalOrder(schemas, at) };
}

/** The operations of a path item, with the path item's own parameters. */
function itemOperations(
  item: JsonObject,
  at: string,
): readonly { readonly method: string; readonly operation: JsonObject }[] {
  return Object.entries(item).flatMap(([method, value]) =>
    HTTP_METHODS.has(method) ? [{ method, operation: objectAt(value, `${at} ${method}`) }] : [],
  );
}

const pathParameterNames = (parameters: Json | undefined, at: string): readonly string[] =>
  parameters === undefined
    ? []
    : arrayAt(parameters, at).flatMap((parameter) => {
        const { in: location, name } = objectAt(parameter, at);
        return location === "path" && typeof name === "string" ? [name] : [];
      });

/**
 * @throws when an operation is not keyed by the path it is sent to: it still
 * carries `x-executor-pathTemplate`, it sits on the converter's placeholder for
 * its id (`/people.contactGroups.get`), or its path and its declared path
 * parameters disagree.
 */
function assertRealPaths(spec: JsonObject, at: string): void {
  for (const [path, value] of Object.entries(objectAt(spec.paths, `${at} paths`))) {
    const item = objectAt(value, `${at} ${path}`);
    for (const { method, operation } of itemOperations(item, `${at} ${path}`)) {
      const where = `${at} ${method} ${path}`;
      if (operation[PATH_TEMPLATE] !== undefined)
        throw new Error(`${where}: carries ${PATH_TEMPLATE}; run realGooglePaths first`);
      const id = operation.operationId;
      if (typeof id === "string") {
        const placeholder = `/${id.replace(/[^A-Za-z0-9._~-]+/g, "/")}`;
        if (path === placeholder || path.startsWith(`${placeholder}/`))
          throw new Error(`${where}: ${id} has a placeholder path, not the path it is sent to`);
      }
      const used = [...path.matchAll(PATH_PARAMETER)].map(([, name]) => name!).sort(byText);
      const declared = [
        ...pathParameterNames(item.parameters, `${at} ${path} parameters`),
        ...pathParameterNames(operation.parameters, `${where} parameters`),
      ].sort(byText);
      if (used.join("\n") !== declared.join("\n"))
        throw new Error(
          `${where}: the path names {${used.join("}, {")}} ` +
            `but the operation declares ${JSON.stringify(declared)}`,
        );
    }
  }
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
  return itemOperations(item, at).map(({ method, operation }) => {
    const where = `${at} ${method}`;
    const url = singleServerUrl(operation.servers, `${where} servers`) ?? itemUrl;
    if (url === undefined) throw new Error(`${where}: no server`);
    return { method, operation, url };
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

const sortedKeys = (value: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => byText(a, b)));

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

type SchemaRewrite = (schema: JsonObject, at: string) => JsonObject;

/** Rebuilds a schema tree innermost first, rewriting every schema in it. */
function mapSchema(schema: Json, at: string, f: SchemaRewrite): Json {
  if (!isJsonObject(schema)) return schema;
  const mapped = mapValues(schema, (value, key) => {
    const where = `${at}/${key}`;
    if (SUBSCHEMA.has(key)) return mapSchema(value, where, f);
    if (SUBSCHEMA_MAP.has(key) && isJsonObject(value))
      return mapValues(value, (each, name) => mapSchema(each, `${where}/${name}`, f));
    if (SUBSCHEMA_LIST.has(key) && Array.isArray(value))
      return value.map((each, index) => mapSchema(each, `${where}/${index}`, f));
    return value;
  });
  return f(mapped, at);
}

function withTypedDefault(schema: JsonObject, at: string): JsonObject {
  const value = schema.default;
  if (value === undefined || hasType(schema.type, value)) return schema;
  const parsed = typeof value === "string" ? discoveryScalar(schema.type, value) : undefined;
  if (parsed === undefined)
    throw new Error(
      `${at}: default ${JSON.stringify(value)} is not a ${JSON.stringify(schema.type)}`,
    );
  return { ...schema, default: parsed };
}

const withSortedProperties = (schema: JsonObject): JsonObject =>
  isJsonObject(schema.properties)
    ? { ...schema, properties: sortedKeys(schema.properties) }
    : schema;

/** A Parameter or Media Type Object: its schema lives under `schema`. */
const schemaField = (value: Json, at: string, f: SchemaRewrite): Json =>
  isJsonObject(value)
    ? mapValues(value, (field, key) => (key === "schema" ? mapSchema(field, `${at}/schema`, f) : field))
    : value;

const parameterSchemas = (parameters: Json, at: string, f: SchemaRewrite): Json =>
  Array.isArray(parameters)
    ? parameters.map((parameter, index) => schemaField(parameter, `${at}/${index}`, f))
    : parameters;

/** A Request Body or Response Object: its schemas live under `content`. */
const bodySchemas = (body: Json, at: string, f: SchemaRewrite): Json =>
  isJsonObject(body)
    ? mapValues(body, (value, key) =>
        key === "content" && isJsonObject(value)
          ? mapValues(value, (media, type) => schemaField(media, `${at}/content/${type}`, f))
          : value,
      )
    : body;

const operationSchemas = (operation: Json, at: string, f: SchemaRewrite): Json =>
  isJsonObject(operation)
    ? mapValues(operation, (value, key) => {
        switch (key) {
          case "parameters":
            return parameterSchemas(value, `${at}/parameters`, f);
          case "requestBody":
            return bodySchemas(value, `${at}/requestBody`, f);
          case "responses":
            return isJsonObject(value)
              ? mapValues(value, (response, status) =>
                  bodySchemas(response, `${at}/responses/${status}`, f),
                )
              : value;
          default:
            return value;
        }
      })
    : operation;

/** Rewrites every schema of a document: parameters, bodies, responses and
 *  component schemas. */
function withSchemas(spec: JsonObject, at: string, f: SchemaRewrite): JsonObject {
  const paths = objectAt(spec.paths, `${at} paths`);
  const components = spec.components;
  return {
    ...spec,
    paths: mapValues(paths, (item, path) => {
      const where = `${at} #/paths/${path}`;
      return isJsonObject(item)
        ? mapValues(item, (value, key) =>
            key === "parameters"
              ? parameterSchemas(value, `${where}/parameters`, f)
              : HTTP_METHODS.has(key)
                ? operationSchemas(value, `${where}/${key}`, f)
                : value,
          )
        : item;
    }),
    ...(isJsonObject(components) && isJsonObject(components.schemas)
      ? {
          components: {
            ...components,
            schemas: mapValues(components.schemas, (schema, name) =>
              mapSchema(schema, `${at} #/components/schemas/${name}`, f),
            ),
          },
        }
      : {}),
  };
}

/** A path item's fields: its own fields first, then its methods in HTTP_METHODS order. */
const fieldRank = (key: string): number => [...HTTP_METHODS].indexOf(key);
const LOCATIONS = ["path", "query", "header", "cookie"];

/** Path parameters in path order, then the rest by location and name. */
function sortedParameters(parameters: Json, path: string, at: string): Json {
  const rank = (parameter: Json) => {
    const { in: location, name } = objectAt(parameter, at);
    const locationRank = typeof location === "string" ? LOCATIONS.indexOf(location) : -1;
    if (locationRank < 0 || typeof name !== "string")
      throw new Error(`${at}: parameter ${JSON.stringify(name)} has no valid location`);
    return {
      location: locationRank,
      position: location === "path" ? path.indexOf(`{${name}}`) : 0,
      name,
    };
  };
  return arrayAt(parameters, at)
    .map((parameter) => ({ parameter, rank: rank(parameter) }))
    .sort(
      (a, b) =>
        a.rank.location - b.rank.location ||
        a.rank.position - b.rank.position ||
        byText(a.rank.name, b.rank.name),
    )
    .map(({ parameter }) => parameter);
}

/** The document with its paths and component schemas sorted by name, each path
 *  item's methods in HTTP_METHODS order and each operation's parameters sorted. */
function inCanonicalOrder(spec: JsonObject, at: string): JsonObject {
  const paths = objectAt(spec.paths, `${at} paths`);
  const components = spec.components;
  return {
    ...spec,
    paths: mapValues(sortedKeys(paths), (value, path) => {
      const item = objectAt(value, `${at} ${path}`);
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => fieldRank(a) - fieldRank(b) || byText(a, b))
          .map(([key, field]): [string, Json] => {
            const where = `${at} ${key} ${path}`;
            if (key === "parameters") return [key, sortedParameters(field, path, where)];
            if (!HTTP_METHODS.has(key)) return [key, field];
            const operation = objectAt(field, where);
            return [
              key,
              operation.parameters === undefined
                ? operation
                : {
                    ...operation,
                    parameters: sortedParameters(operation.parameters, path, `${where} parameters`),
                  },
            ];
          }),
      );
    }),
    ...(isJsonObject(components) && isJsonObject(components.schemas)
      ? { components: { ...components, schemas: sortedKeys(components.schemas) } }
      : {}),
  };
}
