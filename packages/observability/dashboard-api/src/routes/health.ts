/**
 * Health check endpoint — GET /admin/api/health
 */

import { jsonResponse } from "../router.js";

const startedAt = Date.now();

export interface DashboardCapabilities {
  readonly fileSystem: boolean;
  readonly runtimeViews: boolean;
  readonly commands: boolean;
  readonly dataSources: boolean;
  readonly governance: boolean;
  readonly orchestration: {
    readonly temporal: boolean;
    readonly scheduler: boolean;
    readonly taskBoard: boolean;
    readonly harness: boolean;
  };
  /** Per-command availability — only present when commands are available. */
  readonly commandsDetail?: {
    readonly pauseHarness: boolean;
    readonly resumeHarness: boolean;
    readonly retryDlq: boolean;
    readonly pauseSchedule: boolean;
    readonly resumeSchedule: boolean;
    readonly deleteSchedule: boolean;
  };
}

export function handleHealth(capabilities?: DashboardCapabilities): Response {
  return jsonResponse({
    status: "ok",
    uptimeMs: Date.now() - startedAt,
    ...(capabilities !== undefined ? { capabilities } : {}),
  });
}
