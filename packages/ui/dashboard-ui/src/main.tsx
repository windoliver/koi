import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp, type DashboardClient } from "./app.js";
import { ErrorState } from "./components/error-state.js";
import "./index.css";

interface DashboardEmbedConfig {
  // Base URL of the dashboard API. Auth must be enforced by the deployment
  // (same-origin cookies, reverse-proxy injected headers, or an SSO gateway).
  // Bearer tokens MUST NOT be passed in via window state — that would expose
  // the credential to any script running on the page (XSS, third-party JS, etc.).
  readonly baseUrl: string;
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
        <ErrorState message="Dashboard is not configured. The embedder must provide window.__KOI_DASHBOARD_CLIENT__ (preferred) or window.__KOI_DASHBOARD_CONFIG__ with a baseUrl that is reachable without a client-side bearer token (cookie auth, reverse proxy, etc.)." />
      </StrictMode>,
    );
    return;
  }

  // Build a client without any client-side bearer-token wiring. Auth must come
  // from the embedding deployment (same-origin cookies, reverse proxy, SSO).
  // Embedders that need bearer auth must construct a credentialed fetch and
  // attach a fully-built client via window.__KOI_DASHBOARD_CLIENT__.
  const { createDashboardClient } = await import("@koi/dashboard-client");
  const credentialedFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> =>
    globalThis.fetch(input, { ...init, credentials: "include" });
  const client = createDashboardClient({ baseUrl: config.baseUrl, fetch: credentialedFetch });
  root.render(
    <StrictMode>
      <DashboardApp client={client} />
    </StrictMode>,
  );
}

void bootstrap();
