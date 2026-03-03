/**
 * E2B SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { mountNexusFuse } from "@koi/sandbox-cloud-base";
import { createE2bInstance } from "./instance.js";
import type { E2bAdapterConfig, E2bCreateOpts } from "./types.js";
import { validateE2bConfig } from "./validate.js";

/**
 * Create an E2B SandboxAdapter.
 *
 * Validates configuration and returns a Result. On success, the adapter
 * creates E2B cloud sandbox instances on demand.
 */
export function createE2bAdapter(config: E2bAdapterConfig): Result<SandboxAdapter, KoiError> {
  const validated = validateE2bConfig(config);
  if (!validated.ok) return validated;

  const resolvedConfig = validated.value;

  return {
    ok: true,
    value: {
      name: "e2b",
      create: async (_profile: SandboxProfile) => {
        const opts: E2bCreateOpts = {
          apiKey: resolvedConfig.apiKey,
          ...(resolvedConfig.template !== undefined ? { template: resolvedConfig.template } : {}),
          ...(resolvedConfig.mounts !== undefined && resolvedConfig.mounts.length > 0
            ? { mounts: resolvedConfig.mounts }
            : {}),
        };
        const sdkSandbox = await resolvedConfig.client.createSandbox(opts);
        const instance = createE2bInstance(sdkSandbox);
        if (_profile.nexusMounts !== undefined && _profile.nexusMounts.length > 0) {
          await mountNexusFuse(instance, _profile.nexusMounts);
        }
        return instance;
      },
    },
  };
}
