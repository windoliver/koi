/**
 * Health check endpoint — GET /dashboard/api/health
 */

import { jsonResponse } from "../router.js";

const startedAt = Date.now();

export interface DashboardCapabilities {
  readonly fileSystem: boolean;
  readonly runtimeViews: boolean;
  readonly commands: boolean;
  readonly orchestration: {
    readonly temporal: boolean;
    readonly scheduler: boolean;
    readonly taskBoard: boolean;
    readonly harness: boolean;
  };
}

export function handleHealth(capabilities?: DashboardCapabilities): Response {
  return jsonResponse({
    status: "ok",
    uptimeMs: Date.now() - startedAt,
    ...(capabilities !== undefined ? { capabilities } : {}),
  });
}
