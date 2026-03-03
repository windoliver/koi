/**
 * Shared Nexus config and path validation.
 *
 * Pure validation functions returning Result<T, KoiError>.
 */

import type { KoiError, NexusPath, Result } from "@koi/core";
import { MAX_NEXUS_PATH_LENGTH, nexusPath } from "@koi/core";

/** Validate Nexus connection config. */
export function validateNexusConfig(config: {
  readonly baseUrl: string;
  readonly apiKey: string;
}): Result<void, KoiError> {
  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Nexus baseUrl must be a non-empty string",
        retryable: false,
      },
    };
  }
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Nexus apiKey must be a non-empty string",
        retryable: false,
      },
    };
  }
  return { ok: true, value: undefined };
}

/** Validate and brand a raw string as a NexusPath. */
export function validateNexusPath(raw: string): Result<NexusPath, KoiError> {
  if (!raw || raw.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Nexus path must be a non-empty string",
        retryable: false,
      },
    };
  }
  if (raw.startsWith("/")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Nexus path must not start with '/'",
        retryable: false,
      },
    };
  }
  if (raw.includes("..")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Nexus path must not contain '..'",
        retryable: false,
      },
    };
  }
  if (raw.length > MAX_NEXUS_PATH_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Nexus path exceeds max length of ${MAX_NEXUS_PATH_LENGTH} characters`,
        retryable: false,
      },
    };
  }
  return { ok: true, value: nexusPath(raw) };
}
