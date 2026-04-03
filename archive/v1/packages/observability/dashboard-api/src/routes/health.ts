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
  // Flatten capabilities to match the client's expected shape.
  // Client expects: { temporal, scheduler, taskboard, harness, forge, gateway, nexus, governance }
  // Server has: { orchestration: { temporal, scheduler, taskBoard, harness }, fileSystem, ... }
  const flatCapabilities =
    capabilities !== undefined
      ? {
          temporal: capabilities.orchestration.temporal,
          scheduler: capabilities.orchestration.scheduler,
          taskboard: capabilities.orchestration.taskBoard,
          harness: capabilities.orchestration.harness,
          forge: capabilities.runtimeViews,
          gateway: capabilities.runtimeViews,
          nexus: capabilities.fileSystem,
          governance: capabilities.governance,
        }
      : undefined;

  return jsonResponse({
    status: "ok",
    uptimeMs: Date.now() - startedAt,
    ...(flatCapabilities !== undefined ? { capabilities: flatCapabilities } : {}),
  });
}
