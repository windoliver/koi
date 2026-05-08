import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp, type DashboardClient } from "./app.js";
import { ErrorState } from "./components/error-state.js";
import "./index.css";

interface DashboardEmbedConfig {
  readonly baseUrl: string;
  readonly authToken?: string | undefined;
}

declare global {
  interface Window {
    __KOI_DASHBOARD_CONFIG__?: DashboardEmbedConfig;
    __KOI_DASHBOARD_CLIENT__?: DashboardClient;
  }
}

const container = document.getElementById("root");

if (!container) {
  throw new Error("Dashboard root element not found.");
}

const root = createRoot(container);

async function bootstrap(): Promise<void> {
  const injectedClient = window.__KOI_DASHBOARD_CLIENT__;
  if (injectedClient) {
    root.render(
      <StrictMode>
        <DashboardApp client={injectedClient} />
      </StrictMode>,
    );
    return;
  }

  const config = window.__KOI_DASHBOARD_CONFIG__;
  if (!config || typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
    root.render(
      <StrictMode>
        <ErrorState message="Dashboard is not configured. The embedder must provide window.__KOI_DASHBOARD_CONFIG__ with a baseUrl, or window.__KOI_DASHBOARD_CLIENT__." />
      </StrictMode>,
    );
    return;
  }

  const { createDashboardClient } = await import("@koi/dashboard-client");
  const baseFetch = globalThis.fetch.bind(globalThis);
  const authToken = config.authToken;
  const fetchWithAuth = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (authToken && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${authToken}`);
    }
    return baseFetch(input, { ...init, headers });
  };

  const client = createDashboardClient({ baseUrl: config.baseUrl, fetch: fetchWithAuth });
  root.render(
    <StrictMode>
      <DashboardApp client={client} />
    </StrictMode>,
  );
}

void bootstrap();
