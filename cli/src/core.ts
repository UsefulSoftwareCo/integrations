type HttpMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";
export type ParamLocation = "path" | "query" | "header" | "cookie";

export interface OpenApiSpec {
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  paths?: Record<string, PathItem>;
  components?: {
    parameters?: Record<string, OpenApiParameter>;
    schemas?: Record<string, OpenApiSchema>;
  };
}

type PathItem = {
  parameters?: OpenApiParameter[];
} & Partial<Record<HttpMethod, OpenApiOperation>>;

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
}

interface Ref {
  $ref: string;
}

type OpenApiParameter = Ref | {
  name: string;
  in: ParamLocation;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
};

type OpenApiRequestBody = Ref | {
  required?: boolean;
  description?: string;
};

export type OpenApiSchema = Ref | {
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  const?: unknown;
};

export interface Param {
  name: string;
  flag: string;
  in: ParamLocation;
  required: boolean;
  description: string;
  schema?: OpenApiSchema;
}

export interface Op {
  id: string;
  cmd: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  pathParams: Param[];
  queryParams: Param[];
  hasBody: boolean;
  bodyRequired: boolean;
}

export interface Entry {
  id: string;
  kind: string;
  slug: string;
  name: string;
  description?: string;
  domain?: string;
  popularity?: number;
}

const HTTP_METHODS = new Set<HttpMethod>(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function resolveRef<T>(spec: OpenApiSpec, value: T | Ref | undefined): T | undefined {
  if (!value) return undefined;
  if (!("$ref" in (value as Ref))) return value as T;

  const ref = (value as Ref).$ref;
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current as T;
}

export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
}

function resolvedParams(spec: OpenApiSpec, pathItem: PathItem, op: OpenApiOperation): Param[] {
  const params = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]
    .map((param) => resolveRef<Exclude<OpenApiParameter, Ref>>(spec, param))
    .filter((param): param is Exclude<OpenApiParameter, Ref> => Boolean(param));

  const seen = new Set<string>();
  const result: Param[] = [];
  for (const param of params) {
    const key = `${param.in}:${param.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: param.name,
      flag: kebabCase(param.name),
      in: param.in,
      required: param.required ?? param.in === "path",
      description: param.description ?? "",
      schema: param.schema,
    });
  }
  return result;
}

export function deriveOps(spec: OpenApiSpec): Op[] {
  const ops: Op[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, value] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method as HttpMethod)) continue;
      const operation = value as OpenApiOperation | undefined;
      if (!operation?.operationId) continue;

      const params = resolvedParams(spec, pathItem, operation);
      const pathOrder = pathParamNames(path);
      const pathParams = pathOrder
        .map((name) => params.find((param) => param.in === "path" && param.name === name))
        .filter((param): param is Param => Boolean(param));

      const queryParams = params.filter((param) => param.in === "query");
      const requestBody = resolveRef<Exclude<OpenApiRequestBody, Ref>>(spec, operation.requestBody);
      ops.push({
        id: operation.operationId,
        cmd: kebabCase(operation.operationId),
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? "",
        description: operation.description ?? operation.summary ?? "",
        pathParams,
        queryParams,
        hasBody: Boolean(requestBody),
        bodyRequired: Boolean(requestBody?.required),
      });
    }
  }

  return ops.sort((a, b) => a.cmd.localeCompare(b.cmd));
}

export function enumValues(spec: OpenApiSpec, schema?: OpenApiSchema): unknown[] {
  const resolved = resolveRef<Exclude<OpenApiSchema, Ref>>(spec, schema);
  if (!resolved) return [];
  if (resolved.enum) return resolved.enum;
  if (resolved.const !== undefined) return [resolved.const];
  for (const branch of [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])]) {
    const values = enumValues(spec, branch);
    if (values.length) return values;
  }
  return [];
}

export function defaultValue(spec: OpenApiSpec, schema?: OpenApiSchema): unknown {
  const resolved = resolveRef<Exclude<OpenApiSchema, Ref>>(spec, schema);
  return resolved && "default" in resolved ? resolved.default : undefined;
}

export function schemaType(spec: OpenApiSpec, schema?: OpenApiSchema): string {
  const resolved = resolveRef<Exclude<OpenApiSchema, Ref>>(spec, schema);
  if (!resolved) return "value";
  if (resolved.type) return resolved.type;
  if (resolved.enum) return "enum";
  if (resolved.oneOf?.length) return "value";
  if (resolved.anyOf?.length) return "value";
  return "value";
}

function paramForFlag(op: Op, flag: string): Param | undefined {
  return op.queryParams.find((param) => param.flag === flag || param.name === flag);
}

function stringifyDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function validateEnum(spec: OpenApiSpec, param: Param, value: string) {
  const values = enumValues(spec, param.schema).map(String);
  if (values.length && !values.includes(value)) {
    throw new Error(`--${param.flag} must be one of ${values.join(", ")}`);
  }
}

export function parseOperationArgs(spec: OpenApiSpec, op: Op, argv: string[]) {
  const positionals: string[] = [];
  const query = new Map<string, string[]>();
  let data: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      continue;
    }

    let name = token.slice(2);
    let value: string | undefined;
    const equal = name.indexOf("=");
    if (equal !== -1) {
      value = name.slice(equal + 1);
      name = name.slice(0, equal);
    }

    if (name === "data") {
      if (!op.hasBody) throw new Error("unknown flag --data");
      if (value === undefined) value = argv[++i];
      if (value === undefined) throw new Error("--data requires a JSON value");
      data = value;
      continue;
    }

    let noBoolean = false;
    if (name.startsWith("no-")) {
      const candidate = paramForFlag(op, name.slice(3));
      if (candidate && schemaType(spec, candidate.schema) === "boolean") {
        noBoolean = true;
        name = name.slice(3);
        value = "false";
      }
    }

    const param = paramForFlag(op, name);
    if (!param) throw new Error(`unknown flag --${name}`);

    const type = schemaType(spec, param.schema);
    if (value === undefined && type === "boolean") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && /^(true|false)$/i.test(next)) value = argv[++i];
      else value = noBoolean ? "false" : "true";
    } else if (value === undefined) {
      value = argv[++i];
    }

    if (value === undefined) throw new Error(`--${param.flag} requires a value`);
    validateEnum(spec, param, value);
    const values = query.get(param.name) ?? [];
    values.push(value);
    query.set(param.name, values);
  }

  if (positionals.length < op.pathParams.length) {
    throw new Error(`usage: integrations ${op.cmd} ${op.pathParams.map((param) => `<${param.name}>`).join(" ")}`);
  }
  if (positionals.length > op.pathParams.length) {
    throw new Error(`unexpected argument "${positionals[op.pathParams.length]}"`);
  }

  for (const param of op.queryParams) {
    if (!query.has(param.name)) {
      const fallback = stringifyDefault(defaultValue(spec, param.schema));
      if (fallback !== undefined) query.set(param.name, [fallback]);
    }
    if (param.required && !query.has(param.name)) throw new Error(`missing required flag --${param.flag}`);
  }

  if (op.bodyRequired && data === undefined) throw new Error("--data is required");

  return { positionals, query, data };
}

function isEntry(value: unknown): value is Entry {
  return typeof value === "object"
    && value !== null
    && typeof (value as Entry).kind === "string"
    && typeof (value as Entry).slug === "string"
    && typeof (value as Entry).name === "string"
    && ("domain" in value ? typeof (value as Entry).domain === "string" || (value as Entry).domain === undefined : true);
}

export function entryArray(value: unknown): Entry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(isEntry)) return undefined;
  return value as Entry[];
}

export function parseRegistryEntries(value: unknown, source = "registry response"): Entry[] {
  const direct = entryArray(value);
  if (direct) return direct;
  if (typeof value === "object" && value !== null) {
    const data = (value as Record<string, unknown>).data;
    const entries = entryArray(data);
    if (entries) return entries;
  }
  throw new Error(`${source} did not contain registry records`);
}
