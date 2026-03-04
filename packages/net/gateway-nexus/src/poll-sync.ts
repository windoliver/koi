/**
 * Generic polling sync utility for Nexus-backed stores.
 *
 * Periodically calls a poll function to sync remote state into
 * the local cache. Integrates with the degradation state machine.
 */

import type { DegradationConfig } from "./config.js";
import type { DegradationState } from "./degradation.js";
import { recordFailure, recordSuccess, shouldProbe } from "./degradation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PollSyncConfig {
  readonly intervalMs: number;
  readonly degradationConfig?: DegradationConfig | undefined;
}

export interface PollSyncHandle {
  /** Stop polling. */
  readonly dispose: () => void;
  /** Force an immediate poll. */
  readonly poll: () => Promise<void>;
}

/**
 * The poll function returns updated degradation state.
 * Returning `ok: true` means the poll succeeded, `ok: false` means it failed.
 */
type PollFn = () => Promise<{ readonly ok: boolean }>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPollSync(
  config: PollSyncConfig,
  pollFn: PollFn,
  getDegradation: () => DegradationState,
  setDegradation: (state: DegradationState) => void,
): PollSyncHandle {
  let timer: ReturnType<typeof setInterval> | undefined;

  async function doPoll(): Promise<void> {
    const state = getDegradation();
    // In degraded mode, only poll if probe interval elapsed
    if (state.mode === "degraded" && !shouldProbe(state, config.degradationConfig)) {
      return;
    }
    try {
      const result = await pollFn();
      if (result.ok) {
        setDegradation(recordSuccess(getDegradation()));
      } else {
        setDegradation(recordFailure(getDegradation(), config.degradationConfig));
      }
    } catch (_e: unknown) {
      setDegradation(recordFailure(getDegradation(), config.degradationConfig));
    }
  }

  timer = setInterval(() => {
    void doPoll();
  }, config.intervalMs);

  return {
    dispose(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    poll: doPoll,
  };
}
