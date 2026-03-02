/**
 * NexusTaskQueue configuration and validation.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export interface NexusTaskQueueConfig {
  /** Nexus Astraea base URL (e.g., "https://scheduler.nexus.example.com"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Request timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export function validateNexusTaskQueueConfig(
  config: unknown,
): Result<NexusTaskQueueConfig, KoiError> {
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

  if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== "number" || c.timeoutMs <= 0)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config 'timeoutMs' must be a positive number (milliseconds)",
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

  const validated: NexusTaskQueueConfig = {
    baseUrl: (c.baseUrl as string).replace(/\/+$/, ""),
    apiKey: c.apiKey as string,
    ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs as number } : {}),
    ...(c.fetch !== undefined ? { fetch: c.fetch as typeof globalThis.fetch } : {}),
  };

  return { ok: true, value: validated };
}
