/**
 * Adapter from @koi/search-provider's Retriever to ask_guide's search callback.
 *
 * Bridges the Retriever<T> contract (SearchQuery → SearchPage) to
 * the simpler (query, maxResults) → GuideSearchResult[] signature.
 */

import type { Retriever } from "@koi/search-provider";
import type { AskGuideConfig, GuideSearchResult } from "./types.js";

/**
 * Wraps a Retriever into the search callback expected by AskGuideConfig.
 *
 * Maps SearchResult fields to GuideSearchResult:
 * - title: from metadata.title (falls back to result id)
 * - content: SearchResult.content (the matched text)
 * - source: SearchResult.source (file path or identifier)
 */
export function createRetrieverSearch(retriever: Retriever): AskGuideConfig["search"] {
  return async (query: string, maxResults: number = 10): Promise<readonly GuideSearchResult[]> => {
    const result = await retriever.retrieve({ text: query, limit: maxResults });
    if (!result.ok) {
      return [];
    }

    return result.value.results.map(
      (r): GuideSearchResult => ({
        title: typeof r.metadata["title"] === "string" ? r.metadata["title"] : r.id,
        content: r.content,
        source: r.source,
      }),
    );
  };
}
