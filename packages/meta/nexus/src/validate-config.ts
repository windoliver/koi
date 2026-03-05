/**
 * Boundary validation for NexusStackConfig.
 *
 * Validates required fields and rejects obviously invalid values
 * before any backends are created.
 */

import type { KoiError, Result } from "@koi/core";
import { validation } from "@koi/core";
import type { NexusStackConfig } from "./types.js";

/**
 * Validates a NexusStackConfig at the system boundary.
 *
 * Returns a validation error if:
 * - `baseUrl` is missing or empty
 * - `apiKey` is missing or empty
 */
export function validateNexusStackConfig(config: NexusStackConfig): Result<void, KoiError> {
  if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
    return {
      ok: false,
      error: validation("NexusStackConfig.baseUrl is required and must be a non-empty string"),
    };
  }
  if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
    return {
      ok: false,
      error: validation("NexusStackConfig.apiKey is required and must be a non-empty string"),
    };
  }
  return { ok: true, value: undefined };
}
