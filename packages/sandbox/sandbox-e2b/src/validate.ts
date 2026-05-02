import type { KoiError, Result } from "@koi/core";
import type { E2bAdapterConfig, ResolvedE2bConfig } from "./types.js";

const E2B_API_KEY_ENV = "E2B_API_KEY";

/** Validate adapter config and resolve env-fallback values. */
export function validateE2bConfig(config: E2bAdapterConfig): Result<ResolvedE2bConfig, KoiError> {
  const apiKey = config.apiKey ?? process.env[E2B_API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    const error: KoiError = {
      code: "VALIDATION",
      message: `E2B API key required — pass config.apiKey or set ${E2B_API_KEY_ENV}`,
      retryable: false,
    };
    return { ok: false, error };
  }

  if (config.client === undefined) {
    const error: KoiError = {
      code: "VALIDATION",
      message: "E2B client required — inject an E2bClient implementation",
      retryable: false,
    };
    return { ok: false, error };
  }

  const resolved: ResolvedE2bConfig = {
    apiKey,
    client: config.client,
    ...(config.template !== undefined ? { template: config.template } : {}),
  };
  return { ok: true, value: resolved };
}
