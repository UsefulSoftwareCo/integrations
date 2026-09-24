import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Gmail's published definition uses the catalog endpoint for every operation", () => {
  const curated = JSON.parse(readFileSync(new URL("../curated/google.json", import.meta.url), "utf8"));
  const gmail = curated.interfaces.find((entry: { slug: string }) => entry.slug === "google-gmail");
  const text = readFileSync(new URL("../public/specs/google/google-gmail.json", import.meta.url), "utf8");
  const spec = JSON.parse(text);
  const origin = new URL(gmail.endpoint).origin;
  expect(new URL(spec.servers[0].url).origin).toBe(origin);

  let operations = 0;
  for (const path of Object.values(spec.paths) as Record<string, unknown>[]) {
    for (const [method, operation] of Object.entries(path)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      operations++;
      const server =
        (operation as { servers?: { url: string }[] }).servers?.[0] ??
        (path.servers as { url: string }[] | undefined)?.[0] ??
        spec.servers[0];
      expect(new URL(server.url).origin).toBe(origin);
    }
  }
  expect(operations).toBe(75);
  const manifest = JSON.parse(readFileSync(new URL("../public/specs/google/manifest.json", import.meta.url), "utf8"));
  expect(manifest.specs["google-gmail"].bytes).toBe(Buffer.byteLength(text));
  expect(manifest.specs["google-gmail"].operations).toBe(operations);
});
