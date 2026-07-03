export const SYSTEM = "Map the public developer integration surfaces for the given domain. Return only JSON matching the supplied schema.";

export function buildUserMessage(domain: string, corpus: unknown, detect?: unknown): string {
  return `Domain: ${domain}\nDetected:\n${JSON.stringify(detect)}\nCorpus:\n${JSON.stringify(corpus)}`;
}

export const DISCOVERY_JSON_SCHEMA = {
  name: "discovery_result_v3",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "credentials", "surfaces"],
    properties: {
      summary: { type: "string" },
      credentials: { type: "object", additionalProperties: true },
      surfaces: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  },
};
