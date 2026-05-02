import type { KoiError, Result } from "@koi/core";
import type { DaytonaAdapterConfig, ResolvedDaytonaConfig } from "./types.js";

const API_KEY_ENV = "DAYTONA_API_KEY";
const API_URL_ENV = "DAYTONA_API_URL";
const DEFAULT_TARGET = "us";

/** Validate adapter config and resolve env-fallback values. */
export function validateDaytonaConfig(
  config: DaytonaAdapterConfig,
): Result<ResolvedDaytonaConfig, KoiError> {
  const apiKey = config.apiKey ?? process.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Daytona API key required — pass config.apiKey or set ${API_KEY_ENV}`,
      retryable: false,
    };
    return { ok: false, error };
  }

  if (config.client === undefined) {
    const error: KoiError = {
      code: "VALIDATION",
      message: "Daytona client required — inject a DaytonaClient implementation",
      retryable: false,
    };
    return { ok: false, error };
  }

  const apiUrl = config.apiUrl ?? process.env[API_URL_ENV];
  const target = config.target ?? DEFAULT_TARGET;

  const resolved: ResolvedDaytonaConfig = {
    apiKey,
    target,
    client: config.client,
    ...(apiUrl !== undefined && apiUrl !== "" ? { apiUrl } : {}),
  };
  return { ok: true, value: resolved };
}
