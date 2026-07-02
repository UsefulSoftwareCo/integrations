/** Versioned JSON envelope for prerendered catalog API routes. */
export const API_ENVELOPE_VERSION = 1 as const;

export interface ApiEnvelope<T> {
  version: typeof API_ENVELOPE_VERSION;
  generatedAt: string;
  data: T;
}

export function apiEnvelope<T>(data: T): ApiEnvelope<T> {
  return { version: API_ENVELOPE_VERSION, generatedAt: new Date().toISOString(), data };
}

/** Accept bare arrays (v0) or `{ data }` envelopes (v1+). */
export function unwrapEnvelope<T>(json: T[] | ApiEnvelope<T[]>): T[] {
  return Array.isArray(json) ? json : json.data;
}
