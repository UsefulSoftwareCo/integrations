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
}

export interface SearchIndexEntry {
  domain: string;
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
