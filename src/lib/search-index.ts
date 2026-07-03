import searchIndexJson from "../../output/search-index.json";
import type { Kind } from "./types.ts";

export interface SearchIndexEntry {
  domain: string;
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
