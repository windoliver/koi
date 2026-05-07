import type { KoiError, Result } from "@koi/core";

export interface NexusSchedulerConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

export function validateNexusSchedulerConfig(
  config: unknown,
): Result<NexusSchedulerConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const value = config as Record<string, unknown>;

  if (typeof value.baseUrl !== "string" || value.baseUrl === "") {
    return validationError("Config requires a non-empty 'baseUrl' string");
  }

  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey === "")) {
    return validationError("Config 'apiKey' must be a non-empty string when provided");
  }

  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" || value.timeoutMs <= 0)
  ) {
    return validationError("Config 'timeoutMs' must be a positive number (milliseconds)");
  }

  if (
    value.visibilityTimeoutMs !== undefined &&
    (typeof value.visibilityTimeoutMs !== "number" || value.visibilityTimeoutMs <= 0)
  ) {
    return validationError("Config 'visibilityTimeoutMs' must be a positive number (milliseconds)");
  }

  if (value.fetch !== undefined && typeof value.fetch !== "function") {
    return validationError("Config 'fetch' must be a function");
  }

  return {
    ok: true,
    value: {
      baseUrl: value.baseUrl.replace(/\/+$/, ""),
      ...(value.apiKey !== undefined ? { apiKey: value.apiKey } : {}),
      ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
      ...(value.visibilityTimeoutMs !== undefined
        ? { visibilityTimeoutMs: value.visibilityTimeoutMs }
        : {}),
      ...(value.fetch !== undefined ? { fetch: value.fetch as typeof globalThis.fetch } : {}),
    },
  };
}

function validationError(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
    },
  };
}
