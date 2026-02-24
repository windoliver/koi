/**
 * E2B adapter config validation.
 */

import type { KoiError, Result } from "@koi/core";
import type { E2bAdapterConfig } from "./types.js";

/** Validated E2B config with resolved API key. */
export interface ValidatedE2bConfig {
  readonly apiKey: string;
  readonly template?: string;
  readonly mounts?: E2bAdapterConfig["mounts"];
}

/** Validate E2B adapter configuration, resolving env fallbacks. */
export function validateE2bConfig(config: E2bAdapterConfig): Result<ValidatedE2bConfig, KoiError> {
  const apiKey = config.apiKey ?? process.env.E2B_API_KEY;

  if (apiKey === undefined || apiKey === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "E2B API key is required: set apiKey in config or E2B_API_KEY env var",
        retryable: false,
      },
    };
  }

  if (config.mounts !== undefined) {
    for (const mount of config.mounts) {
      if (!mount.mountPath.startsWith("/")) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `E2B mount path must be absolute: "${mount.mountPath}"`,
            retryable: false,
          },
        };
      }
    }
  }

  const result: ValidatedE2bConfig = {
    apiKey,
    ...(config.template !== undefined ? { template: config.template } : {}),
    ...(config.mounts !== undefined ? { mounts: config.mounts } : {}),
  };

  return { ok: true, value: result };
}
