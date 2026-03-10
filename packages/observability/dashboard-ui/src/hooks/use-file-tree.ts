/**
 * File tree hook — fetches directory listings from Nexus filesystem.
 *
 * Uses React Query for on-demand fetches (not Zustand) per Decision 5A.
 * Tree store tracks UI state (expanded/selected); this hook fetches data.
 */

import { useQuery } from "@tanstack/react-query";
import type { FsEntry } from "../lib/api-client.js";
import { fetchFsList } from "../lib/api-client.js";
import { useTreeStore } from "../stores/tree-store.js";

export interface FileTreeNode {
  readonly entry: FsEntry;
  readonly children?: readonly FileTreeNode[];
  readonly isLoading?: boolean;
}

/**
 * Fetches directory contents for a given path.
 * Refetches when the tree is invalidated (SSE nexus events).
 */
export function useFileTree(
  path: string,
  options?: { readonly enabled?: boolean },
): {
  readonly entries: readonly FsEntry[];
  readonly isLoading: boolean;
  readonly error: Error | null;
} {
  const lastInvalidatedAt = useTreeStore((s) => s.lastInvalidatedAt);

  const query = useQuery({
    queryKey: ["fs-list", path, lastInvalidatedAt],
    queryFn: () => fetchFsList(path),
    enabled: options?.enabled !== false,
    staleTime: 30_000,
  });

  return {
    entries: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
  };
}
