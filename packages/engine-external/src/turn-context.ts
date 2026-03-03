/**
 * Shared turn lifecycle context for long-lived and PTY modes.
 *
 * Encapsulates: queue creation, abort signal handling, timeout timer,
 * no-output watchdog, and the finish() function that flushes parser,
 * emits done event, and ends the queue.
 */

import type { ContentBlock, EngineEvent, EngineOutput, EngineStopReason } from "@koi/core";
import type { AsyncQueue } from "./async-queue.js";
import { createAsyncQueue } from "./async-queue.js";
import { createZeroMetrics } from "./shared-helpers.js";
import type { OutputParser } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnContext {
  readonly queue: AsyncQueue<EngineEvent>;
  readonly finish: (stopReason: EngineStopReason) => void;
  readonly cleanup: () => void;
  readonly isFinished: () => boolean;
  /** Reset the no-output watchdog (call on each output chunk). */
  readonly resetWatchdog: () => void;
}

export interface TurnContextConfig {
  readonly timeoutMs: number;
  readonly noOutputTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly parser: OutputParser;
  readonly startTime: number;
  /** Called when the turn is finished (after queue.end()). Optional cleanup hook. */
  readonly onFinished?: ((stopReason: EngineStopReason) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTurnContext(config: TurnContextConfig): TurnContext {
  const queue = createAsyncQueue<EngineEvent>();

  // let: flag to prevent double-ending the queue
  let finished = false;
  // let: timeout handle — declared before finish to avoid temporal dead zone
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  // let: watchdog handle — restarted on each output chunk
  let watchdogHandle: ReturnType<typeof setTimeout> | undefined;

  function clearTimers(): void {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (watchdogHandle !== undefined) {
      clearTimeout(watchdogHandle);
      watchdogHandle = undefined;
    }
  }

  function finish(stopReason: EngineStopReason): void {
    if (finished) return;
    finished = true;
    clearTimers();

    const flushed = config.parser.flush();
    for (const event of flushed) {
      queue.push(event);
    }
    const content: readonly ContentBlock[] = [];
    const output: EngineOutput = {
      content,
      stopReason,
      metrics: createZeroMetrics(Date.now() - config.startTime),
    };
    queue.push({ kind: "done", output });
    queue.end();
    config.onFinished?.(stopReason);
  }

  function resetWatchdog(): void {
    if (config.noOutputTimeoutMs <= 0) return;
    if (finished) return;
    if (watchdogHandle !== undefined) clearTimeout(watchdogHandle);
    watchdogHandle = setTimeout(() => finish("error"), config.noOutputTimeoutMs);
  }

  // Wire abort signal
  if (config.signal !== undefined) {
    if (config.signal.aborted) {
      finish("interrupted");
    } else {
      config.signal.addEventListener("abort", () => finish("interrupted"), { once: true });
    }
  }

  // Start overall timeout
  if (config.timeoutMs > 0 && !finished) {
    timeoutHandle = setTimeout(() => finish("error"), config.timeoutMs);
  }

  // Start initial watchdog
  if (config.noOutputTimeoutMs > 0 && !finished) {
    watchdogHandle = setTimeout(() => finish("error"), config.noOutputTimeoutMs);
  }

  return {
    queue,
    finish,
    cleanup: clearTimers,
    isFinished: () => finished,
    resetWatchdog,
  };
}
