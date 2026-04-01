/**
 * Cloudflare adapter config validation.
 */

import type { KoiError, Result } from "@koi/core";
import type { CloudflareAdapterConfig, CloudflareClient } from "./types.js";

/** Validated Cloudflare config with resolved API token and guaranteed client. */
export interface ValidatedCloudflareConfig {
  readonly apiToken: string;
  readonly accountId?: string;
  readonly r2Mounts?: CloudflareAdapterConfig["r2Mounts"];
  readonly client: CloudflareClient;
}

/** Validate Cloudflare adapter configuration. */
export function validateCloudflareConfig(
  config: CloudflareAdapterConfig,
): Result<ValidatedCloudflareConfig, KoiError> {
  if (config.client === undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Cloudflare SDK client is required: pass a client in CloudflareAdapterConfig for production use, or use a mock client for testing",
        retryable: false,
      },
    };
  }

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
    client: config.client,
    ...(config.accountId !== undefined ? { accountId: config.accountId } : {}),
    ...(config.r2Mounts !== undefined ? { r2Mounts: config.r2Mounts } : {}),
  };

  return { ok: true, value: result };
}
