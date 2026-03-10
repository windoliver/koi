/**
 * Search hook — searches Nexus filesystem content.
 *
 * Debounced by 300ms to avoid excessive API calls during typing.
 * Uses React Query for caching.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { FsSearchResult } from "../lib/api-client.js";
import { fetchFsSearch } from "../lib/api-client.js";

const DEBOUNCE_MS = 300;
const MAX_RESULTS = 50;

export function useSearch(query: string): {
  readonly results: readonly FsSearchResult[];
  readonly isSearching: boolean;
  readonly error: Error | null;
} {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const result = useQuery({
    queryKey: ["fs-search", debouncedQuery],
    queryFn: () => fetchFsSearch(debouncedQuery, { maxResults: MAX_RESULTS }),
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  });

  return {
    results: result.data ?? [],
    isSearching: result.isLoading,
    error: result.error instanceof Error ? result.error : null,
  };
}
