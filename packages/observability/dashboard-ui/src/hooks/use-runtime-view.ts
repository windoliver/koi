/**
 * Generic hook for fetching runtime view data from /api/view/ endpoints.
 *
 * Uses React Query for caching and refetching.
 */

import { useQuery } from "@tanstack/react-query";
import { getDashboardConfig } from "../lib/dashboard-config.js";

const API_BASE = getDashboardConfig().apiPath;

async function fetchView<T>(viewPath: string): Promise<T> {
  const response = await fetch(`${API_BASE}/view${viewPath}`);
  const body = (await response.json()) as {
    readonly ok: boolean;
    readonly data: T;
    readonly error?: { readonly message: string };
  };
  if (!body.ok) {
    throw new Error(body.error?.message ?? "Failed to fetch view");
  }
  return body.data;
}

export function useRuntimeView<T>(
  viewPath: string,
  options?: { readonly enabled?: boolean; readonly refetchInterval?: number },
): {
  readonly data: T | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
} {
  const query = useQuery<T>({
    queryKey: ["runtime-view", viewPath],
    queryFn: () => fetchView<T>(viewPath),
    enabled: options?.enabled !== false,
    ...(options?.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
    staleTime: 10_000,
  });

  return {
    data: query.data as T | undefined,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
    refetch: () => {
      void query.refetch();
    },
  };
}
