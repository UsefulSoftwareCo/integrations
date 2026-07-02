import { describe, expect, test } from "bun:test";
import { PROBE_KEYS, buildConventionRows } from "./conventions.ts";

describe("buildConventionRows", () => {
  test("distinguishes found, missing, and unprobed convention states", () => {
    const rows = buildConventionRows(
      {
        found: [PROBE_KEYS.integrationsJson],
        probed: [PROBE_KEYS.integrationsJson, PROBE_KEYS.llmsTxt],
        integrationsJson: {
          url: "https://example.com/.well-known/integrations.json",
          result: { version: 3 },
        },
        llmsTxt: false,
      },
      "example.com",
    );

    expect(rows.find((row) => row.key === PROBE_KEYS.integrationsJson)).toMatchObject({
      status: "found",
      detail: "https://example.com/.well-known/integrations.json",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.llmsTxt)).toMatchObject({
      status: "missing",
      detail: "Nothing at /llms.txt",
      docsHref: "/own-your-page/",
    });
    expect(rows.find((row) => row.key === PROBE_KEYS.agentCard)).toMatchObject({
      status: "unprobed",
      detail: "Not probed yet",
    });
  });
});
