/**
 * Search hook — searches Nexus filesystem content.
 *
 * Debounced by 300ms to avoid excessive API calls during typing.
 * Uses React Query for caching. Filters results by the active saved view's
 * rootPaths (client-side) and passes glob to the server.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
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
    queryKey: ["fs-search", debouncedQuery, glob],
    queryFn: () =>
      fetchFsSearch(
        debouncedQuery,
        glob !== undefined ? { maxResults: MAX_RESULTS, glob } : { maxResults: MAX_RESULTS },
      ),
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  });

  // Filter results by rootPaths client-side
  const filtered = useMemo(() => {
    const data = result.data ?? [];
    if (rootPaths === undefined || rootPaths.length === 0) return data;
    return data.filter((r) => rootPaths.some((root) => r.path.startsWith(root)));
  }, [result.data, rootPaths]);

  return {
    results: filtered,
    isSearching: result.isLoading,
    error: result.error instanceof Error ? result.error : null,
  };
}
