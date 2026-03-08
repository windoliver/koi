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
 * Validates a resolved NexusStackConfig at the system boundary.
 *
 * For remote mode: baseUrl is required.
 * For embed mode: baseUrl is filled by ensureNexusRunning() before this is called.
 * apiKey is optional (embed mode runs without auth).
 */
export function validateNexusStackConfig(config: NexusStackConfig): Result<void, KoiError> {
  if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
    return {
      ok: false,
      error: validation("NexusStackConfig.baseUrl is required and must be a non-empty string"),
    };
  }
  // apiKey is optional — embed mode runs without authentication
  return { ok: true, value: undefined };
}
