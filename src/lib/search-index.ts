import searchIndexJson from "../../output/search-index.json";
import type { Kind } from "./types.ts";

/** How to connect one surface of a domain. `slug` is the registry's stable
 *  identifier for that surface — the thing a client should record so it can
 *  later tell whether it already added this, without inferring identity from a
 *  hostname. */
export interface SearchIndexSurface {
  kind: Kind;
  slug: string;
  url?: string;
  /** A hand-picked product mark from the curated record, when it beats the
   *  domain favicon. */
  icon?: string;
  /** How to authenticate, for surfaces whose connect target cannot carry it
   *  itself (a GraphQL endpoint has no spec document). */
  auth?: { kind?: string; header?: string; note?: string };
  /** RFC 6902 JSON Patch a client should apply to the spec before use. */
  specOverrides?: unknown[];
}

export interface SearchIndexEntry {
  domain: string;
  /** Set on standalone product rows (many products on one vendor domain, like
   *  Microsoft Graph workloads); domain-level rows are named by their domain. */
  name?: string;
  surfaces?: SearchIndexSurface[];
  description: string;
  kinds: Kind[];
  devtool: boolean;
  popularity: number;
  total: number;
}

const searchIndexData = searchIndexJson as SearchIndexEntry[];

export function searchIndex(): SearchIndexEntry[] {
  return searchIndexData;
}
