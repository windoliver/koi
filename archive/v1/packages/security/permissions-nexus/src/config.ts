/**
 * Configuration types and validation for @koi/permissions-nexus.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Top-level configuration
// ---------------------------------------------------------------------------

export interface NexusPermissionsConfig {
  /** Nexus server base URL. */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate raw config. */
export function validateNexusPermissionsConfig(
  raw: unknown,
): Result<NexusPermissionsConfig, KoiError> {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusPermissionsConfig must be a non-null object",
        retryable: false,
      },
    };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.baseUrl !== "string" || obj.baseUrl === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusPermissionsConfig.baseUrl must be a non-empty string",
        retryable: false,
      },
    };
  }

  if (typeof obj.apiKey !== "string" || obj.apiKey === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusPermissionsConfig.apiKey must be a non-empty string",
        retryable: false,
      },
    };
  }

  const config: NexusPermissionsConfig = {
    baseUrl: obj.baseUrl as string,
    apiKey: obj.apiKey as string,
    ...(obj.fetch !== undefined ? { fetch: obj.fetch as typeof globalThis.fetch } : {}),
  };

  return { ok: true, value: config };
}
