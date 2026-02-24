/**
 * Cloudflare adapter config validation.
 */

import type { KoiError, Result } from "@koi/core";
import type { CloudflareAdapterConfig } from "./types.js";

/** Validated Cloudflare config with resolved API token. */
export interface ValidatedCloudflareConfig {
  readonly apiToken: string;
  readonly accountId?: string;
  readonly r2Mounts?: CloudflareAdapterConfig["r2Mounts"];
}

/** Validate Cloudflare adapter configuration. */
export function validateCloudflareConfig(
  config: CloudflareAdapterConfig,
): Result<ValidatedCloudflareConfig, KoiError> {
  const apiToken = config.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;

  if (apiToken === undefined || apiToken === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Cloudflare API token is required: set apiToken in config or CLOUDFLARE_API_TOKEN env var",
        retryable: false,
      },
    };
  }

  if (config.r2Mounts !== undefined) {
    for (const mount of config.r2Mounts) {
      if (!mount.mountPath.startsWith("/")) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Cloudflare R2 mount path must be absolute: "${mount.mountPath}"`,
            retryable: false,
          },
        };
      }
    }
  }

  const result: ValidatedCloudflareConfig = {
    apiToken,
    ...(config.accountId !== undefined ? { accountId: config.accountId } : {}),
    ...(config.r2Mounts !== undefined ? { r2Mounts: config.r2Mounts } : {}),
  };

  return { ok: true, value: result };
}
