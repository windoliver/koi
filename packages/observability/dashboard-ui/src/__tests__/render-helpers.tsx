/**
 * Render helpers — wraps React Testing Library render() with providers.
 *
 * Pattern: Use renderWithProviders(<MyComponent />) in all component tests
 * to get Zustand stores + QueryClient properly initialized.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { useAgentsStore } from "../stores/agents-store.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { render } from "./setup.js";

/** Create a fresh QueryClient for testing — no retries, no refetch. */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** Reset all Zustand stores to initial state. Call in beforeEach(). */
export function resetStores(): void {
  useAgentsStore.setState({
    agents: {},
    lastUpdated: 0,
    isLoading: true,
    error: null,
  });
  useConnectionStore.setState({
    status: "disconnected",
  });
}

/** Render a component wrapped with QueryClientProvider. */
export function renderWithProviders(
  ui: ReactElement,
  queryClient?: QueryClient,
): RenderResult {
  const client = queryClient ?? createTestQueryClient();

  function Wrapper({ children }: { readonly children: React.ReactNode }): ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  return render(ui, { wrapper: Wrapper });
}
