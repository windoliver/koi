/**
 * File content hook — fetches a single file's content from Nexus.
 *
 * Uses React Query for on-demand reads. Content is cached until
 * the tree is invalidated by SSE events.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchFsRead } from "../lib/api-client.js";
import { useTreeStore } from "../stores/tree-store.js";

export function useFileContent(path: string | null): {
  readonly content: string | null;
  readonly editable: boolean;
  readonly isLoading: boolean;
  readonly error: Error | null;
} {
  const lastInvalidatedAt = useTreeStore((s) => s.lastInvalidatedAt);

  const query = useQuery({
    queryKey: ["fs-read", path, lastInvalidatedAt],
    // enabled: path !== null guards this — path is always non-null when queryFn runs
    queryFn: () => {
      if (path === null) throw new Error("path is null");
      return fetchFsRead(path);
    },
    enabled: path !== null,
    staleTime: 60_000,
  });

  return {
    content: query.data?.content ?? null,
    editable: query.data?.editable ?? false,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
  };
}
