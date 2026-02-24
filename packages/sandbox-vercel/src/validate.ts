/**
 * Vercel adapter config validation.
 */

import type { KoiError, Result } from "@koi/core";
import type { VercelAdapterConfig } from "./types.js";

/** Validated Vercel config with resolved API token. */
export interface ValidatedVercelConfig {
  readonly apiToken: string;
  readonly teamId?: string;
  readonly projectId?: string;
}

/** Validate Vercel adapter configuration, resolving env fallbacks. */
export function validateVercelConfig(
  config: VercelAdapterConfig,
): Result<ValidatedVercelConfig, KoiError> {
  const apiToken = config.apiToken ?? process.env.VERCEL_TOKEN;

  if (apiToken === undefined || apiToken === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Vercel API token is required: set apiToken in config or VERCEL_TOKEN env var",
        retryable: false,
      },
    };
  }

  const result: ValidatedVercelConfig = {
    apiToken,
    ...(config.teamId !== undefined ? { teamId: config.teamId } : {}),
    ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
  };

  return { ok: true, value: result };
}
