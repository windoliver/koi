/**
 * Retry wrapper for MailboxComponent.send() — delivers messages with
 * exponential backoff on transient failures.
 *
 * Used by both CompletionNotifier (plan-level) and per-task notifications
 * to ensure at-least-once delivery semantics.
 */

import type {
  AgentMessage,
  AgentMessageInput,
  KoiError,
  MailboxComponent,
  Result,
} from "@koi/core";
import type { AutonomousLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RetrySendConfig {
  /** Maximum number of retry attempts after the initial try. Default: 3. */
  readonly maxRetries?: number | undefined;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  readonly baseDelayMs?: number | undefined;
  /** Maximum delay in ms for backoff cap. Default: 10000. */
  readonly maxDelayMs?: number | undefined;
  /** Optional logger for retry diagnostics. */
  readonly logger?: AutonomousLogger | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 10_000;

// ---------------------------------------------------------------------------
// Backoff computation (exported for testing)
// ---------------------------------------------------------------------------

/** Compute exponential backoff: min(baseMs * 2^attempt, maxMs). */
export function computeRetryDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

// ---------------------------------------------------------------------------
// Send with retry
// ---------------------------------------------------------------------------

/**
 * Send a message via mailbox with retry on transient (retryable) failures.
 *
 * - Succeeds immediately if the first attempt works.
 * - Retries up to `maxRetries` times with exponential backoff for retryable errors.
 * - Returns immediately on non-retryable errors (no retry).
 * - Returns the final Result after all attempts exhaust.
 */
export async function sendWithRetry(
  mailbox: MailboxComponent,
  message: AgentMessageInput,
  config?: RetrySendConfig | undefined,
): Promise<Result<AgentMessage, KoiError>> {
  const maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const logger = config?.logger;

  // let justified: tracks the last error across retry attempts
  let lastResult: Result<AgentMessage, KoiError> | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await mailbox.send(message);
    if (result.ok) return result;

    lastResult = result;

    // Non-retryable errors: bail immediately
    if (!result.error.retryable) {
      logger?.warn(
        `send failed (non-retryable, code=${result.error.code}): ${result.error.message}`,
      );
      return result;
    }

    // Last attempt exhausted: don't sleep, just return
    if (attempt >= maxRetries) break;

    const delay = computeRetryDelay(attempt, baseDelayMs, maxDelayMs);
    logger?.debug?.(
      `send failed, retrying in ${String(delay)}ms (attempt ${String(attempt + 1)}/${String(maxRetries)}): ${result.error.message}`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  const finalError =
    lastResult !== undefined && !lastResult.ok ? lastResult.error.message : "unknown";
  logger?.warn(`send failed after ${String(maxRetries)} retries: ${finalError}`);

  // lastResult is guaranteed non-undefined because maxRetries >= 0 means at least 1 attempt
  return lastResult as Result<AgentMessage, KoiError>;
}
