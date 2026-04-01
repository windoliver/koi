/**
 * Dashboard configuration types and defaults.
 */

export interface DashboardConfig {
  /** URL path prefix for the dashboard UI. Default: "/admin" */
  readonly basePath?: string;
  /** URL path prefix for API endpoints. Default: "/admin/api" */
  readonly apiPath?: string;
  /** Absolute path to built dashboard-ui dist/ directory. */
  readonly assetsDir?: string;
  /** SSE event batch interval in milliseconds. Default: 100 */
  readonly sseBatchIntervalMs?: number;
  /** Maximum concurrent SSE connections. Default: 50 */
  readonly maxSseConnections?: number;
  /** Enable CORS headers. Default: false */
  readonly cors?: boolean;
}

export const DEFAULT_DASHBOARD_CONFIG: Readonly<{
  readonly basePath: "/admin";
  readonly apiPath: "/admin/api";
  readonly sseBatchIntervalMs: 100;
  readonly maxSseConnections: 50;
  readonly cors: false;
}> = Object.freeze({
  basePath: "/admin",
  apiPath: "/admin/api",
  sseBatchIntervalMs: 100,
  maxSseConnections: 50,
  cors: false,
}) satisfies Required<Omit<DashboardConfig, "assetsDir">>;
