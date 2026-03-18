/**
 * Daytona SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
  mountNexusFuse,
} from "@koi/sandbox-cloud-base";
import { createDaytonaInstance } from "./instance.js";
import type { DaytonaAdapterConfig, DaytonaCreateOpts, DaytonaSdkSandbox } from "./types.js";
import { validateDaytonaConfig } from "./validate.js";

/** Create a Daytona SandboxAdapter. */
export function createDaytonaAdapter(
  config: DaytonaAdapterConfig,
): Result<SandboxAdapter, KoiError> {
  const validated = validateDaytonaConfig(config);
  if (!validated.ok) return validated;

  const resolvedConfig = validated.value;

  async function wrapSdk(sdkSandbox: DaytonaSdkSandbox, profile: SandboxProfile) {
    const instance = createDaytonaInstance(sdkSandbox);
    if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) {
      await mountNexusFuse(instance, profile.nexusMounts);
    }
    return instance;
  }

  const findSandboxFn = resolvedConfig.client.findSandbox;

  return {
    ok: true,
    value: {
      name: "daytona",
      create: async (_profile: SandboxProfile) => {
        const unsupported = detectUnsupportedProfileFields(_profile);
        if (unsupported !== undefined) {
          throw new Error(formatUnsupportedProfileError("Daytona", unsupported));
        }

        const opts: DaytonaCreateOpts = {
          apiKey: resolvedConfig.apiKey,
          apiUrl: resolvedConfig.apiUrl,
          target: resolvedConfig.target,
          ...(resolvedConfig.volumes !== undefined && resolvedConfig.volumes.length > 0
            ? { volumes: resolvedConfig.volumes }
            : {}),
        };
        const sdkSandbox = await resolvedConfig.client.createSandbox(opts);
        return wrapSdk(sdkSandbox, _profile);
      },
      ...(findSandboxFn !== undefined
        ? {
            findOrCreate: async (scope: string, profile: SandboxProfile) => {
              const unsupported = detectUnsupportedProfileFields(profile);
              if (unsupported !== undefined) {
                throw new Error(formatUnsupportedProfileError("Daytona", unsupported));
              }

              // Try finding an existing sandbox by scope
              const existing = await findSandboxFn(scope);
              if (existing !== undefined) {
                return wrapSdk(existing, profile);
              }

              // Not found — create fresh with scope metadata so findSandbox
              // can locate it in the next session.
              const opts: DaytonaCreateOpts = {
                apiKey: resolvedConfig.apiKey,
                apiUrl: resolvedConfig.apiUrl,
                target: resolvedConfig.target,
                ...(resolvedConfig.volumes !== undefined && resolvedConfig.volumes.length > 0
                  ? { volumes: resolvedConfig.volumes }
                  : {}),
                metadata: { "koi.sandbox.scope": scope },
              };
              const sdkSandbox = await resolvedConfig.client.createSandbox(opts);
              return wrapSdk(sdkSandbox, profile);
            },
          }
        : {}),
    },
  };
}
