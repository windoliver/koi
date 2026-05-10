import type { HarnessStatus, KoiError } from "@koi/core";
import { type RetrySendOptions, type RetrySendResult, sendWithRetry } from "./retry-send.js";

export interface CompletionNotifierConfig {
  readonly send: (message: string) => Promise<void>;
  readonly retry?: RetrySendOptions | undefined;
  readonly formatCompleted?: ((status: HarnessStatus) => string) | undefined;
  readonly formatFailed?: ((status: HarnessStatus, error: KoiError) => string) | undefined;
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

export function createCompletionNotifier(config: CompletionNotifierConfig): CompletionNotifier {
  return {
    notifyCompleted(status: HarnessStatus): Promise<RetrySendResult> {
      const message = (config.formatCompleted ?? formatCompletedMessage)(status);
      return sendWithRetry(config.send, message, config.retry);
    },
    notifyFailed(status: HarnessStatus, error: KoiError): Promise<RetrySendResult> {
      const message = (config.formatFailed ?? formatFailedMessage)(status, error);
      return sendWithRetry(config.send, message, config.retry);
    },
  };
}
