import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OgFonts, OgImageData, OgInput } from "../src/lib/og.tsx";
import type { DiscoveryDoc, Surface } from "../src/lib/surface-view.ts";

const root = process.cwd();
const outDir = "/tmp/og-preview";
process.env.SATORI_STANDALONE = "1";

async function font(path: string): Promise<ArrayBuffer> {
  const bytes = await readFile(join(root, path));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function fonts(): Promise<OgFonts> {
  const [geist400, geist500, geist600, mono400, mono500, mono600] = await Promise.all([
    font("public/fonts/geist-400.woff"),
    font("public/fonts/geist-500.woff"),
    font("public/fonts/geist-600.woff"),
    font("public/fonts/geist-mono-400.woff"),
    font("public/fonts/geist-mono-500.woff"),
    font("public/fonts/geist-mono-600.woff"),
  ]);
  return { geist400, geist500, geist600, mono400, mono500, mono600 };
}

async function favicon(domain: string): Promise<OgImageData | null> {
  const res = await fetch(`https://integrations.sh/logo/${encodeURIComponent(domain)}?sz=128`).catch(() => null);
  const contentType = res?.headers.get("content-type") ?? "";
  if (!res?.ok || !contentType.toLowerCase().startsWith("image/")) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { contentType, dataUri: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` };
}

async function discovery(domain: string, fallback: DiscoveryDoc): Promise<DiscoveryDoc> {
  const path = join(root, "dist", "disc", `${domain}.json`);
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as DiscoveryDoc;
}

const registryBasis = { via: "detected" as const, signal: "registry" };
const gitlabSurface: Surface = {
  slug: "graphql",
  name: "GitLab GraphQL API",
  type: "graphql",
  basis: registryBasis,
  url: "https://gitlab.com/api/graphql",
  auth: {
    status: "required",
    entries: [{
      basis: registryBasis,
      use: [
        { id: "oauth_app", mechanics: { source: "http", in: "header", headerName: "Authorization", scheme: "Bearer" } },
        { id: "personal_token", mechanics: { source: "http", in: "header", headerName: "PRIVATE-TOKEN" } },
        { id: "ci_job_token", mechanics: { source: "http", in: "header", headerName: "JOB-TOKEN" } },
      ],
    }],
  },
};

const stripeFallback: DiscoveryDoc = {
  credentials: {},
  surfaces: [
    { slug: "stripe-api", name: "Stripe API", type: "http", basis: registryBasis, spec: "https://api.apis.guru/v2/specs/stripe.com/2022-11-15/openapi.json", auth: { status: "unknown" } },
    { slug: "stripe-mcp-server", name: "Stripe MCP server", type: "mcp", basis: registryBasis, url: "https://mcp.stripe.com", auth: { status: "unknown" } },
  ],
};

await mkdir(outDir, { recursive: true });

const { renderOgPng } = await import("../src/lib/og.tsx");
const loadedFonts = await fonts();
const runtime = {
  yoga: font("node_modules/satori/yoga.wasm"),
  resvg: font("node_modules/@resvg/resvg-wasm/index_bg.wasm"),
};
const [stripeIcon, gitlabIcon] = await Promise.all([favicon("stripe.com"), favicon("gitlab.com")]);
const stripeDoc = await discovery("stripe.com", stripeFallback);

const renders: Array<[string, OgInput]> = [
  ["home.png", { kind: "home" as const }],
  ["stripe.com.png", { kind: "domain" as const, domain: "stripe.com", doc: stripeDoc, favicon: stripeIcon }],
  [
    "gitlab.com-graphql.png",
    {
      kind: "surface" as const,
      domain: "gitlab.com",
      surface: gitlabSurface,
      credentials: {
        oauth_app: { label: "OAuth app", type: "oauth2", setup: "" },
        personal_token: { label: "personal token", type: "bearer", setup: "" },
        ci_job_token: { label: "CI job token", type: "bearer", setup: "" },
      },
      favicon: gitlabIcon,
    },
  ],
];

for (const [name, input] of renders) {
  const png = await renderOgPng(input, loadedFonts, runtime);
  await Bun.write(join(outDir, name), png);
}

console.log(renders.map(([name]) => join(outDir, name)).join("\n"));
