/**
 * Daytona adapter config validation.
 */

import type { KoiError, Result } from "@koi/core";
import type { DaytonaAdapterConfig } from "./types.js";

/** Validated Daytona config with resolved API key and URL. */
export interface ValidatedDaytonaConfig {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly target: string;
  readonly volumes?: DaytonaAdapterConfig["volumes"];
}

const DEFAULT_API_URL = "https://app.daytona.io/api";
const DEFAULT_TARGET = "us";

/** Validate Daytona adapter configuration. */
export function validateDaytonaConfig(
  config: DaytonaAdapterConfig,
): Result<ValidatedDaytonaConfig, KoiError> {
  const apiKey = config.apiKey ?? process.env.DAYTONA_API_KEY;

  if (apiKey === undefined || apiKey === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Daytona API key is required: set apiKey in config or DAYTONA_API_KEY env var",
        retryable: false,
      },
    };
  }

  const apiUrl = config.apiUrl ?? process.env.DAYTONA_API_URL ?? DEFAULT_API_URL;
  const target = config.target ?? DEFAULT_TARGET;

  if (config.volumes !== undefined) {
    for (const vol of config.volumes) {
      if (!vol.mountPath.startsWith("/")) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Daytona volume mount path must be absolute: "${vol.mountPath}"`,
            retryable: false,
          },
        };
      }
    }
  }

  const result: ValidatedDaytonaConfig = {
    apiKey,
    apiUrl,
    target,
    ...(config.volumes !== undefined ? { volumes: config.volumes } : {}),
  };

  return { ok: true, value: result };
}
