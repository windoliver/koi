/**
 * Bridge auto-fire — polls scheduler phase and fires the bridge when harness completes.
 *
 * The scheduler is L2 (@koi/harness-scheduler) with no completion callback,
 * so this thin watcher polls at a configurable interval (default 500ms).
 */

import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { HarnessHandoffBridge } from "./types.js";

// ---------------------------------------------------------------------------
// Config & Handle types
// ---------------------------------------------------------------------------

export interface BridgeAutoFireConfig {
  readonly scheduler: HarnessScheduler;
  readonly bridge: HarnessHandoffBridge;
  /** Poll interval in ms. Default: 500. */
  readonly pollIntervalMs?: number | undefined;
  /** Injectable delay for testability. Default: Bun.sleep. */
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
  /** Called when an unexpected error occurs during firing. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface BridgeAutoFireHandle {
  /** Cancel the watcher. Prevents future firing. */
  readonly cancel: () => void;
  /** Resolves when the watcher exits (either after firing, cancel, or scheduler failure). */
  readonly done: Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a phase-watcher that auto-fires the bridge when the scheduler stops. */
export function createBridgeAutoFire(config: BridgeAutoFireConfig): BridgeAutoFireHandle {
  const pollMs = config.pollIntervalMs ?? 500;
  const delay = config.delay ?? ((ms: number) => Bun.sleep(ms));

  // let justified: mutable cancellation flag
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
  };

  const done = (async (): Promise<void> => {
    while (!cancelled) {
      const phase = config.scheduler.status().phase;

      if (phase === "stopped") {
        // Defense-in-depth: check hasFired() before calling
        if (!config.bridge.hasFired()) {
          try {
            await config.bridge.onHarnessCompleted();
          } catch (e: unknown) {
            config.onError?.(e);
          }
        }
        return;
      }

      if (phase === "failed") {
        // Retries exhausted — do not fire
        return;
      }

      await delay(pollMs);
    }
  })();

  return { cancel, done };
}
