import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PageShell } from "./components/layout/page-shell.js";
import { AgentsPage } from "./pages/agents-page.js";
import { BrowserPage } from "./pages/browser-page.js";
import { useSse } from "./hooks/use-sse.js";
import { getDashboardConfig } from "./lib/dashboard-config.js";

// Module-level is intentional — SPA-only, never SSR.
// React Query is used for on-demand file reads/search only (Decision 5A),
// not for agent data (which goes through Zustand directly).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});

function SseProvider({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  useSse();
  return <>{children}</>;
}

export function App(): React.ReactElement {
  const { basePath } = getDashboardConfig();
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basePath}>
        <SseProvider>
          <Routes>
            <Route element={<PageShell />}>
              <Route index element={<Navigate to="/agents" replace />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/browser" element={<BrowserPage />} />
            </Route>
          </Routes>
        </SseProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
