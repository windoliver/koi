import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { PageShell } from "./components/layout/page-shell.js";
import { AgentsPage } from "./pages/agents-page.js";
import { BrowserPage } from "./pages/browser-page.js";
import { ConsolePage } from "./pages/console-page.js";
import { SelfImprovementPage } from "./pages/self-improvement-page.js";
import { useSse } from "./hooks/use-sse.js";
import { getDashboardConfig } from "./lib/dashboard-config.js";
import { useThemeStore } from "./stores/theme-store.js";

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
  const applyTheme = useThemeStore((s) => s.applyTheme);

  // Apply persisted theme on mount
  useEffect(() => {
    applyTheme();
  }, [applyTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basePath}>
        <SseProvider>
          <Routes>
            <Route element={<PageShell />}>
              <Route index element={<BrowserPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/:agentId/console" element={<ConsolePage />} />
              <Route path="/browser" element={<BrowserPage />} />
              <Route path="/self-improvement" element={<SelfImprovementPage />} />
            </Route>
          </Routes>
        </SseProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
