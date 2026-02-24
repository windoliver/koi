/**
 * Cloudflare SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createCloudflareInstance } from "./instance.js";
import type { CfCreateOpts, CloudflareAdapterConfig } from "./types.js";
import { validateCloudflareConfig } from "./validate.js";

/** Create a Cloudflare SandboxAdapter. */
export function createCloudflareAdapter(
  config: CloudflareAdapterConfig,
): Result<SandboxAdapter, KoiError> {
  const validated = validateCloudflareConfig(config);
  if (!validated.ok) return validated;

  const resolvedConfig = validated.value;
  const client = config.client;

  return {
    ok: true,
    value: {
      name: "cloudflare",
      create: async (_profile: SandboxProfile) => {
        if (client !== undefined) {
          const opts: CfCreateOpts = {
            apiToken: resolvedConfig.apiToken,
            ...(resolvedConfig.accountId !== undefined
              ? { accountId: resolvedConfig.accountId }
              : {}),
          };
          const sdkSandbox = await client.createSandbox(opts);
          return createCloudflareInstance(sdkSandbox);
        }

        throw new Error(
          "Cloudflare SDK client not provided. " +
            "Pass a client in CloudflareAdapterConfig for production use, " +
            "or use a mock client for testing.",
        );
      },
    },
  };
}
