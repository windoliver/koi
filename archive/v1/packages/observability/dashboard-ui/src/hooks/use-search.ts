/**
 * Search hook — searches Nexus filesystem content.
 *
 * Debounced by 300ms to avoid excessive API calls during typing.
 * Uses React Query for caching. Passes path scope to server for
 * pre-truncation filtering so in-scope results aren't lost.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { FsSearchResult } from "../lib/api-client.js";
import { fetchFsSearch } from "../lib/api-client.js";

const DEBOUNCE_MS = 300;
const MAX_RESULTS = 50;

export function useSearch(
  query: string,
  options?: {
    readonly rootPaths?: readonly string[];
    readonly glob?: string;
  },
): {
  readonly results: readonly FsSearchResult[];
  readonly isSearching: boolean;
  readonly error: Error | null;
} {
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const glob = options?.glob;
  const rootPaths = options?.rootPaths;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const result = useQuery({
    queryKey: ["fs-search", debouncedQuery, glob, rootPaths],
    queryFn: () => {
      // Build options object carefully for exactOptionalPropertyTypes
      if (glob !== undefined && rootPaths !== undefined && rootPaths.length > 0) {
        return fetchFsSearch(debouncedQuery, { maxResults: MAX_RESULTS, glob, paths: rootPaths });
      }
      if (glob !== undefined) {
        return fetchFsSearch(debouncedQuery, { maxResults: MAX_RESULTS, glob });
      }
      if (rootPaths !== undefined && rootPaths.length > 0) {
        return fetchFsSearch(debouncedQuery, { maxResults: MAX_RESULTS, paths: rootPaths });
      }
      return fetchFsSearch(debouncedQuery, { maxResults: MAX_RESULTS });
    },
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  });

  return {
    results: result.data ?? [],
    isSearching: result.isLoading,
    error: result.error instanceof Error ? result.error : null,
  };
}
