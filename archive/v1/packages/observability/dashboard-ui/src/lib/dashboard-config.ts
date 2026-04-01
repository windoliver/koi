/**
 * Dashboard runtime configuration — reads from window globals or falls back to defaults.
 *
 * The server can inject config at runtime via a <script> tag setting
 * window.__DASHBOARD_CONFIG__ before the app bundle loads.
 */

interface DashboardRuntimeConfig {
  readonly basePath: string;
  readonly apiPath: string;
}

declare global {
  interface Window {
    readonly __DASHBOARD_CONFIG__?: Partial<DashboardRuntimeConfig>;
  }
}

const DEFAULT_BASE_PATH = "/admin";
const DEFAULT_API_PATH = "/admin/api";

/** Resolve dashboard config from window globals or defaults. */
export function getDashboardConfig(): DashboardRuntimeConfig {
  const injected = typeof window !== "undefined" ? window.__DASHBOARD_CONFIG__ : undefined;

  return {
    basePath: injected?.basePath ?? DEFAULT_BASE_PATH,
    apiPath: injected?.apiPath ?? DEFAULT_API_PATH,
  };
}
