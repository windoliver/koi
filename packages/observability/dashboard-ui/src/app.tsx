import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PageShell } from "./components/layout/page-shell.js";
import { AgentsPage } from "./pages/agents-page.js";
import { useSse } from "./hooks/use-sse.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchInterval: 30_000,
    },
  },
});

function SseProvider({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  useSse(queryClient);
  return <>{children}</>;
}

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/dashboard">
        <SseProvider>
          <Routes>
            <Route element={<PageShell />}>
              <Route index element={<Navigate to="/agents" replace />} />
              <Route path="/agents" element={<AgentsPage />} />
            </Route>
          </Routes>
        </SseProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
