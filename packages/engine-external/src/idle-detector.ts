/**
 * Timestamp-based idle detector with optional prompt regex fast path.
 *
 * Fires `onIdle` when the process has been silent for `idleThresholdMs`,
 * or immediately if the accumulated output ends with a prompt pattern match.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdleDetectorConfig {
  /** Silence threshold (ms) before idle callback fires. */
  readonly idleThresholdMs: number;
  /** Polling interval for timestamp check. Default: 1000 ms. */
  readonly pollIntervalMs?: number | undefined;
  /** Optional regex for prompt-based fast-path idle detection. */
  readonly promptPattern?: RegExp | undefined;
  /** Called when idle threshold is reached or prompt pattern matches. */
  readonly onIdle: () => void;
}

export interface IdleDetector {
  /** Record a chunk of (stripped) output. Resets idle timer and checks prompt regex. */
  readonly recordOutput: (strippedText: string) => void;
  /** Clean up interval timer. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIdleDetector(config: IdleDetectorConfig): IdleDetector {
  const pollIntervalMs = config.pollIntervalMs ?? 1_000;

  // let: tracks when we last saw output
  let lastOutputTime = Date.now();
  // let: accumulated tail of output for prompt matching (last 512 chars)
  let outputTail = "";
  // let: whether we've already fired
  let fired = false;

  function fire(): void {
    if (fired) return;
    fired = true;
    clearInterval(intervalHandle);
    config.onIdle();
  }

  function recordOutput(strippedText: string): void {
    if (fired) return;
    lastOutputTime = Date.now();

    // Maintain a sliding window of the last 512 chars for prompt matching
    if (config.promptPattern !== undefined) {
      outputTail = (outputTail + strippedText).slice(-512);
      if (config.promptPattern.test(outputTail)) {
        fire();
      }
    }
  }

  // Poll for idle timeout
  const intervalHandle = setInterval(() => {
    if (fired) return;
    if (Date.now() - lastOutputTime >= config.idleThresholdMs) {
      fire();
    }
  }, pollIntervalMs);

  return {
    recordOutput,
    dispose(): void {
      fired = true;
      clearInterval(intervalHandle);
    },
  };
}
