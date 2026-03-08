/**
 * Health check polling with exponential backoff.
 *
 * Polls GET /health on the Nexus server until it responds 200
 * or the total timeout is exceeded.
 */

import type { KoiError, Result } from "@koi/core";
import {
  HEALTH_BACKOFF_MULTIPLIER,
  HEALTH_INITIAL_DELAY_MS,
  HEALTH_MAX_INTERVAL_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  HEALTH_TOTAL_TIMEOUT_MS,
} from "./constants.js";
import type { FetchFn } from "./types.js";

/** Poll the Nexus health endpoint until ready or timeout. */
export async function pollHealth(
  baseUrl: string,
  fetchFn?: FetchFn | undefined,
  timeoutMs?: number | undefined,
): Promise<Result<void, KoiError>> {
  const doFetch = fetchFn ?? globalThis.fetch;
  const healthUrl = `${baseUrl}/health`;
  const totalTimeout = timeoutMs ?? HEALTH_TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeout;
  let interval = HEALTH_INITIAL_DELAY_MS;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
      const response = await doFetch(healthUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (response.ok) {
        return { ok: true, value: undefined };
      }
    } catch {
      // Connection refused or timeout — expected during startup
    }

    // Wait before next attempt
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(interval, remaining));
    interval = Math.min(interval * HEALTH_BACKOFF_MULTIPLIER, HEALTH_MAX_INTERVAL_MS);
  }

  return {
    ok: false,
    error: {
      code: "TIMEOUT" as const,
      message: `Nexus health check timed out after ${String(totalTimeout)}ms. Check if Nexus is installed: uv pip install nexus-ai-fs`,
      retryable: true,
      context: { baseUrl, timeoutMs: totalTimeout },
    },
  };
}

/** Single health probe — returns true if Nexus responds 200. */
export async function probeHealth(
  baseUrl: string,
  fetchFn?: FetchFn | undefined,
): Promise<boolean> {
  const doFetch = fetchFn ?? globalThis.fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    const response = await doFetch(`${baseUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}
