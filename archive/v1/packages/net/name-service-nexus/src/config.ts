/**
 * Configuration types and validation for the Nexus-backed ANS backend.
 */

import type { AnsConfig, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Fetch-compatible function type for injectable HTTP clients. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Configuration for the Nexus-backed ANS backend. */
export interface NexusNameServiceConfig {
  /** Nexus server base URL (e.g. "https://nexus.example.com"). */
  readonly baseUrl: string;
  /** API key for Nexus authentication (e.g. "sk-..."). */
  readonly apiKey: string;
  /** Optional Nexus zone scope for name listing. */
  readonly zoneId?: string | undefined;
  /** HTTP request timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  /** Poll interval in milliseconds for sync updates. 0 = disabled. Default: 5_000. */
  readonly pollIntervalMs?: number | undefined;
  /** Maximum number of entries in the local projection cache. Default: 10_000. */
  readonly maxEntries?: number | undefined;
  /** Injectable fetch function for testing. Defaults to globalThis.fetch. */
  readonly fetch?: FetchFn | undefined;
  /** Optional partial ANS config (merged with DEFAULT_ANS_CONFIG). */
  readonly ansConfig?: Partial<AnsConfig> | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default configuration values. */
export const DEFAULT_NEXUS_NAME_SERVICE_CONFIG = {
  timeoutMs: 10_000,
  pollIntervalMs: 5_000,
  maxEntries: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a NexusNameServiceConfig. Returns a typed error on failure. */
export function validateNexusNameServiceConfig(
  config: NexusNameServiceConfig,
): Result<NexusNameServiceConfig, KoiError> {
  if (config.baseUrl === "") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "baseUrl must not be empty", retryable: false },
    };
  }

  if (config.apiKey === "") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "apiKey must not be empty", retryable: false },
    };
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_NEXUS_NAME_SERVICE_CONFIG.timeoutMs;
  if (timeoutMs <= 0) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "timeoutMs must be positive", retryable: false },
    };
  }

  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_NEXUS_NAME_SERVICE_CONFIG.pollIntervalMs;
  if (pollIntervalMs < 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "pollIntervalMs must be non-negative",
        retryable: false,
      },
    };
  }

  const maxEntries = config.maxEntries ?? DEFAULT_NEXUS_NAME_SERVICE_CONFIG.maxEntries;
  if (maxEntries <= 0) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "maxEntries must be positive", retryable: false },
    };
  }

  return { ok: true, value: config };
}
