/**
 * E2B SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
  mountNexusFuse,
} from "@koi/sandbox-cloud-base";
import { createE2bInstance } from "./instance.js";
import type { E2bAdapterConfig, E2bCreateOpts, E2bSdkSandbox } from "./types.js";
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

  async function wrapSdk(sdkSandbox: E2bSdkSandbox, profile: SandboxProfile) {
    const instance = createE2bInstance(sdkSandbox);
    if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) {
      await mountNexusFuse(instance, profile.nexusMounts);
    }
    return instance;
  }

  const resumeFn = resolvedConfig.client.resumeSandbox;

  return {
    ok: true,
    value: {
      name: "e2b",
      create: async (_profile: SandboxProfile) => {
        const unsupported = detectUnsupportedProfileFields(_profile);
        if (unsupported !== undefined) {
          throw new Error(formatUnsupportedProfileError("E2B", unsupported));
        }

        const opts: E2bCreateOpts = {
          apiKey: resolvedConfig.apiKey,
          ...(resolvedConfig.template !== undefined ? { template: resolvedConfig.template } : {}),
          ...(resolvedConfig.mounts !== undefined && resolvedConfig.mounts.length > 0
            ? { mounts: resolvedConfig.mounts }
            : {}),
        };
        const sdkSandbox = await resolvedConfig.client.createSandbox(opts);
        return wrapSdk(sdkSandbox, _profile);
      },
      ...(resumeFn !== undefined
        ? {
            findOrCreate: async (scope: string, profile: SandboxProfile) => {
              const unsupported = detectUnsupportedProfileFields(profile);
              if (unsupported !== undefined) {
                throw new Error(formatUnsupportedProfileError("E2B", unsupported));
              }

              // Try resuming a paused sandbox by scope key
              try {
                const resumed = await resumeFn(scope);
                return wrapSdk(resumed, profile);
              } catch {
                // Resume failed — create fresh with scope metadata
                const opts: E2bCreateOpts = {
                  apiKey: resolvedConfig.apiKey,
                  ...(resolvedConfig.template !== undefined
                    ? { template: resolvedConfig.template }
                    : {}),
                  ...(resolvedConfig.mounts !== undefined && resolvedConfig.mounts.length > 0
                    ? { mounts: resolvedConfig.mounts }
                    : {}),
                  metadata: { "koi.sandbox.scope": scope },
                };
                const sdkSandbox = await resolvedConfig.client.createSandbox(opts);
                return wrapSdk(sdkSandbox, profile);
              }
            },
          }
        : {}),
    },
  };
}
