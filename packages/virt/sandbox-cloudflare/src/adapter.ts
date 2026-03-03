/**
 * Cloudflare SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { mountNexusFuse } from "@koi/sandbox-cloud-base";
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

  return {
    ok: true,
    value: {
      name: "cloudflare",
      create: async (_profile: SandboxProfile) => {
        const opts: CfCreateOpts = {
          apiToken: resolvedConfig.apiToken,
          ...(resolvedConfig.accountId !== undefined
            ? { accountId: resolvedConfig.accountId }
            : {}),
          ...(resolvedConfig.r2Mounts !== undefined && resolvedConfig.r2Mounts.length > 0
            ? { r2Mounts: resolvedConfig.r2Mounts }
            : {}),
        };
        const sdkSandbox = await resolvedConfig.client.createSandbox(opts);
        const instance = createCloudflareInstance(sdkSandbox);
        if (_profile.nexusMounts !== undefined && _profile.nexusMounts.length > 0) {
          await mountNexusFuse(instance, _profile.nexusMounts);
        }
        return instance;
      },
    },
  };
}
