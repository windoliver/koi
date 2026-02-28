/**
 * Configuration types and validation for the Nexus-backed AgentRegistry.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the Nexus-backed AgentRegistry. */
export interface NexusRegistryConfig {
  /** Nexus server base URL (e.g. "https://nexus.example.com"). */
  readonly baseUrl: string;
  /** API key for Nexus authentication (e.g. "sk-..."). */
  readonly apiKey: string;
  /** Optional Nexus zone scope for agent listing. */
  readonly zoneId?: string | undefined;
  /** HTTP request timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  /** Poll interval in milliseconds for watch updates. 0 = disabled. Default: 10_000. */
  readonly pollIntervalMs?: number | undefined;
  /** Startup timeout in milliseconds for initial agent list load. Default: 30_000. */
  readonly startupTimeoutMs?: number | undefined;
  /** Maximum number of entries in the local projection cache. Default: 10_000. */
  readonly maxEntries?: number | undefined;
  /** Injectable fetch function for testing. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default configuration values. */
export const DEFAULT_NEXUS_REGISTRY_CONFIG = {
  timeoutMs: 10_000,
  pollIntervalMs: 10_000,
  startupTimeoutMs: 30_000,
  maxEntries: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a NexusRegistryConfig. Returns a typed error on failure. */
export function validateNexusRegistryConfig(
  config: NexusRegistryConfig,
): Result<NexusRegistryConfig, KoiError> {
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

  const timeoutMs = config.timeoutMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.timeoutMs;
  if (timeoutMs <= 0) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "timeoutMs must be positive", retryable: false },
    };
  }

  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.pollIntervalMs;
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

  const maxEntries = config.maxEntries ?? DEFAULT_NEXUS_REGISTRY_CONFIG.maxEntries;
  if (maxEntries <= 0) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "maxEntries must be positive", retryable: false },
    };
  }

  return { ok: true, value: config };
}
