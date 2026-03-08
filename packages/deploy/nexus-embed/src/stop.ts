/**
 * Stop a running Nexus embed daemon.
 *
 * Reads PID from file, sends SIGTERM, waits for exit, and cleans up state files.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { removeConnectionState } from "./connection-store.js";
import { DEFAULT_DATA_DIR_NAME } from "./constants.js";
import { isProcessAlive, readPid, removePid } from "./pid-manager.js";

/** Maximum time to wait for daemon to exit after SIGTERM (ms). */
const STOP_TIMEOUT_MS = 5_000;

/** Interval between alive checks during shutdown wait (ms). */
const STOP_POLL_INTERVAL_MS = 100;

/** Stop the embed Nexus daemon, wait for exit, and clean up state files. */
export async function stopEmbedNexus(config?: {
  readonly dataDir?: string | undefined;
}): Promise<Result<{ readonly pid: number; readonly wasRunning: boolean }, KoiError>> {
  const dataDir = config?.dataDir ?? join(homedir(), DEFAULT_DATA_DIR_NAME);
  const pid = readPid(dataDir);

  if (pid === undefined) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND" as const,
        message: "No Nexus embed PID file found. Nexus may not be running in embed mode.",
        retryable: false,
        context: { dataDir },
      },
    };
  }

  const wasRunning = isProcessAlive(pid);

  if (wasRunning) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL" as const,
          message: `Failed to send SIGTERM to Nexus (PID ${String(pid)}): ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          cause: err,
        },
      };
    }

    // Wait for the process to actually exit
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await Bun.sleep(STOP_POLL_INTERVAL_MS);
    }

    if (isProcessAlive(pid)) {
      // Force kill if still alive after timeout
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* best effort */
      }
    }
  }

  // Clean up state files regardless
  removePid(dataDir);
  removeConnectionState(dataDir);

  return { ok: true, value: { pid, wasRunning } };
}
