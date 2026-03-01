/**
 * Maps Nexus search hits to Koi SearchResult.
 */

import type { SearchResult } from "@koi/search-provider";
import type { NexusSearchHit } from "./nexus-types.js";

export function mapNexusResult(hit: NexusSearchHit): SearchResult {
  return {
    id: `${hit.path}:${hit.chunk_index}`,
    score: hit.score,
    content: hit.chunk_text,
    source: "nexus",
    metadata: {
      path: hit.path,
      ...(hit.line_start !== undefined ? { lineStart: hit.line_start } : {}),
      ...(hit.line_end !== undefined ? { lineEnd: hit.line_end } : {}),
      ...(hit.keyword_score !== undefined ? { keywordScore: hit.keyword_score } : {}),
      ...(hit.vector_score !== undefined ? { vectorScore: hit.vector_score } : {}),
    },
  };
}
