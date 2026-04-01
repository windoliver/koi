/**
 * NexusPayLedger configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

export interface NexusPayLedgerConfig {
  /** Nexus server base URL (e.g., "https://pay.nexus.example.com"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Request timeout in milliseconds. Default: 10_000. */
  readonly timeout?: number | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export function validatePayLedgerConfig(config: unknown): Result<NexusPayLedgerConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (typeof c.baseUrl !== "string" || c.baseUrl === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a non-empty 'baseUrl' string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Validate URL format
  try {
    new URL(c.baseUrl);
  } catch {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid baseUrl: '${c.baseUrl}' is not a valid URL`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (typeof c.apiKey !== "string" || c.apiKey === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a non-empty 'apiKey' string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.timeout !== undefined && (typeof c.timeout !== "number" || c.timeout <= 0)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config 'timeout' must be a positive number (milliseconds)",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.fetch !== undefined && typeof c.fetch !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config 'fetch' must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: config as NexusPayLedgerConfig };
}
