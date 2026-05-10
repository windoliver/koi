import type { HarnessStatus, KoiError } from "@koi/core";
import { type RetrySendOptions, type RetrySendResult, sendWithRetry } from "./retry-send.js";

export interface CompletionNotifierConfig {
  readonly send: (message: string) => Promise<void>;
  readonly retry?: RetrySendOptions | undefined;
  readonly formatCompleted?: ((status: HarnessStatus) => string) | undefined;
  readonly formatFailed?: ((status: HarnessStatus, error: KoiError) => string) | undefined;
  /**
   * Invoked when sendWithRetry returns a failed result so callers wiring this
   * notifier into harness `OnCompletedCallback` / `OnFailedCallback` (which
   * return `void | Promise<void>` and only observe thrown errors) can still
   * surface the failure. If omitted, `notifyCompleted`/`notifyFailed` throw
   * the underlying transport error so the harness's `noteFailure` path picks
   * it up instead of silently swallowing exhausted delivery.
   */
  readonly onSendFailure?:
    | ((failure: Extract<RetrySendResult, { ok: false }>) => void | Promise<void>)
    | undefined;
}

export interface CompletionNotifier {
  readonly notifyCompleted: (status: HarnessStatus) => Promise<RetrySendResult>;
  readonly notifyFailed: (status: HarnessStatus, error: KoiError) => Promise<RetrySendResult>;
}

function formatCompletedMessage(status: HarnessStatus): string {
  return `Long-running session ${status.harnessId} completed.`;
}

function formatFailedMessage(status: HarnessStatus, error: KoiError): string {
  return `Long-running session ${status.harnessId} failed: ${error.message}`;
}

/**
 * Default transport-error classifier for completion notifications. Treats
 * thrown errors as transient unless the caller provides a stricter classifier
 * via `retry.isTransientError`. This keeps the common case (timeouts, 5xx,
 * connection blips on a webhook/chat sender) retried out of the box.
 */
const RETRY_NEVER_PATTERNS: readonly RegExp[] = [
  /\b401\b|unauthorized/i,
  /\b403\b|forbidden/i,
  /\b400\b|bad request/i,
  /\b404\b|not found/i,
];

function defaultIsTransient(error: Error): boolean {
  const text = `${error.name} ${error.message}`;
  for (const pattern of RETRY_NEVER_PATTERNS) {
    if (pattern.test(text)) return false;
  }
  return true;
}

async function deliverOrSignal(
  config: CompletionNotifierConfig,
  message: string,
): Promise<RetrySendResult> {
  const retry: RetrySendOptions = {
    ...(config.retry ?? {}),
    isTransientError: config.retry?.isTransientError ?? defaultIsTransient,
  };
  const result = await sendWithRetry(config.send, message, retry);
  if (!result.ok) {
    if (config.onSendFailure !== undefined) {
      await config.onSendFailure(result);
    } else {
      throw result.error;
    }
  }
  return result;
}

export function createCompletionNotifier(config: CompletionNotifierConfig): CompletionNotifier {
  return {
    notifyCompleted(status: HarnessStatus): Promise<RetrySendResult> {
      const message = (config.formatCompleted ?? formatCompletedMessage)(status);
      return deliverOrSignal(config, message);
    },
    notifyFailed(status: HarnessStatus, error: KoiError): Promise<RetrySendResult> {
      const message = (config.formatFailed ?? formatFailedMessage)(status, error);
      return deliverOrSignal(config, message);
    },
  };
}
