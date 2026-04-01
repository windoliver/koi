/**
 * Call dedup middleware configuration and validation.
 */

import type { JsonObject } from "@koi/core/common";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { CacheHitInfo, CallDedupStore } from "./types.js";

/** Default TTL: 5 minutes. */
export const DEFAULT_TTL_MS = 300_000;

/** Default maximum cache entries. */
export const DEFAULT_MAX_ENTRIES = 100;

/** Tools excluded from caching by default (mutating / side-effecting). */
export const DEFAULT_EXCLUDE = [
  "shell_exec",
  "file_write",
  "file_delete",
  "file_create",
  "agent_send",
  "agent_spawn",
] as const;

export interface CallDedupConfig {
  /** Cache TTL in milliseconds. Default: 300_000 (5 min). */
  readonly ttlMs?: number | undefined;
  /** Maximum cache entries before LRU eviction. Default: 100. */
  readonly maxEntries?: number | undefined;
  /** Whitelist — only cache these tools. undefined = all non-excluded tools. */
  readonly include?: readonly string[] | undefined;
  /** Blacklist — merged with DEFAULT_EXCLUDE. */
  readonly exclude?: readonly string[] | undefined;
  /** Custom hash function for cache key generation. Must include sessionId for session isolation. */
  readonly hashFn?: ((sessionId: string, toolId: string, input: JsonObject) => string) | undefined;
  /** Clock injection for deterministic TTL tests. */
  readonly now?: (() => number) | undefined;
  /** Custom cache store. Default: in-memory LRU store. */
  readonly store?: CallDedupStore | undefined;
  /** Callback fired on cache hits. */
  readonly onCacheHit?: ((info: CacheHitInfo) => void) | undefined;
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

function isPositiveFiniteInteger(value: unknown): boolean {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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

/**
 * Validates raw config input into a typed CallDedupConfig.
 * Empty `{}` is valid (all defaults apply).
 */
export function validateCallDedupConfig(config: unknown): Result<CallDedupConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  if (Array.isArray(config)) {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (c.ttlMs !== undefined && !isPositiveFiniteInteger(c.ttlMs)) {
    return validationError("'ttlMs' must be a positive finite integer");
  }

  if (c.maxEntries !== undefined && !isPositiveFiniteInteger(c.maxEntries)) {
    return validationError("'maxEntries' must be a positive finite integer");
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
    return validationError(
      "'store' must be an object with get, set, delete, size, and clear methods",
    );
  }

  if (c.onCacheHit !== undefined && typeof c.onCacheHit !== "function") {
    return validationError("'onCacheHit' must be a function");
  }

  return { ok: true, value: config as CallDedupConfig };
}
