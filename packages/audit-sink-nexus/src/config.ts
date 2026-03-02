/**
 * Configuration, defaults, and validation for the Nexus audit sink.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { RetryConfig } from "@koi/errors";

export interface NexusAuditSinkConfig {
  /** Nexus server base URL (e.g., "http://localhost:2026"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Base path prefix for audit entries in Nexus. Default: "/audit". */
  readonly basePath?: string | undefined;
  /** Number of entries before triggering a flush. Default: 50. */
  readonly batchSize?: number | undefined;
  /** Interval in ms between automatic flushes. Default: 5_000. */
  readonly flushIntervalMs?: number | undefined;
  /** Retry config for transient Nexus write failures. */
  readonly retry?: Partial<RetryConfig> | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
export const DEFAULT_BASE_PATH = "/audit";

export function validateNexusAuditSinkConfig(config: NexusAuditSinkConfig): Result<void, KoiError> {
  if (!config.baseUrl) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "baseUrl must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (!config.apiKey) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "apiKey must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (config.batchSize !== undefined && config.batchSize <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "batchSize must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (config.flushIntervalMs !== undefined && config.flushIntervalMs <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "flushIntervalMs must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: undefined };
}
