/**
 * Service reducer — handles log buffer and service status actions.
 *
 * Returns partial state update or undefined if action not handled.
 */

import type { LogLevel, TuiAction, TuiState } from "./types.js";
import { MAX_LOG_BUFFER } from "./types.js";

const LOG_LEVEL_CYCLE: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Reduce service-related actions. Returns undefined if not handled. */
export function reduceService(state: TuiState, action: TuiAction): Partial<TuiState> | undefined {
  switch (action.kind) {
    case "append_log": {
      const updated = [...state.logBuffer, action.entry];
      return {
        logBuffer: updated.length > MAX_LOG_BUFFER ? updated.slice(-MAX_LOG_BUFFER) : updated,
      };
    }

    case "set_log_level":
      return { logLevel: action.level };

    case "clear_logs":
      return { logBuffer: [] };

    case "set_service_status":
      return { serviceStatus: action.status };

    case "set_doctor_checks":
      return { doctorChecks: action.checks };

    case "append_doctor_check":
      return { doctorChecks: [...state.doctorChecks, action.check] };

    case "clear_doctor_checks":
      return { doctorChecks: [] };

    case "set_demo_packs":
      return { demoPacks: action.packs };

    case "set_pending_stop":
      return { pendingStopConfirm: true };

    case "clear_pending_stop":
      return { pendingStopConfirm: false };

    default:
      return undefined;
  }
}

/** Get the next log level in the cycle. */
export function cycleLogLevel(current: LogLevel): LogLevel {
  const idx = LOG_LEVEL_CYCLE.indexOf(current);
  const next = LOG_LEVEL_CYCLE[(idx + 1) % LOG_LEVEL_CYCLE.length];
  return next ?? "info";
}
