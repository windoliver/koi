/**
 * Call dedup — config types and validation.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { CacheHitInfo, CallDedupStore } from "./types.js";

/** Default TTL: 5 minutes. */
export const DEFAULT_TTL_MS = 300_000;

/** Default LRU capacity. */
export const DEFAULT_MAX_ENTRIES = 100;

/** Tools always excluded from caching (mutating / side-effecting). */
export const DEFAULT_EXCLUDE: readonly string[] = [
  "shell_exec",
  "file_write",
  "file_delete",
  "file_create",
  "agent_send",
  "agent_spawn",
] as const;

export interface CallDedupConfig {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly hashFn?: (sessionId: string, toolId: string, input: JsonObject) => string;
  readonly now?: () => number;
  readonly store?: CallDedupStore;
  readonly onCacheHit?: (info: CacheHitInfo) => void;
}

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isValidStore(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.get === "function" &&
    typeof s.set === "function" &&
    typeof s.delete === "function" &&
    typeof s.size === "function" &&
    typeof s.clear === "function"
  );
}

export function validateCallDedupConfig(config: unknown): Result<CallDedupConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }
  if (Array.isArray(config)) {
    return validationError("Config must be a non-null object");
  }
  const c = config as Record<string, unknown>;

  if (c.ttlMs !== undefined && !isPositiveInteger(c.ttlMs)) {
    return validationError("'ttlMs' must be a positive integer");
  }
  if (c.maxEntries !== undefined && !isPositiveInteger(c.maxEntries)) {
    return validationError("'maxEntries' must be a positive integer");
  }
  if (c.include !== undefined && !isStringArray(c.include)) {
    return validationError("'include' must be an array of strings");
  }
  if (c.exclude !== undefined && !isStringArray(c.exclude)) {
    return validationError("'exclude' must be an array of strings");
  }
  if (c.hashFn !== undefined && typeof c.hashFn !== "function") {
    return validationError("'hashFn' must be a function");
  }
  if (c.now !== undefined && typeof c.now !== "function") {
    return validationError("'now' must be a function");
  }
  if (c.store !== undefined && !isValidStore(c.store)) {
    return validationError("'store' must implement get, set, delete, size, clear");
  }
  if (c.onCacheHit !== undefined && typeof c.onCacheHit !== "function") {
    return validationError("'onCacheHit' must be a function");
  }

  return { ok: true, value: config as CallDedupConfig };
}
