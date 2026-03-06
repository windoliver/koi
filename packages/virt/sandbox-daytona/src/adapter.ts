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
import type { DaytonaAdapterConfig, DaytonaCreateOpts } from "./types.js";
import { validateDaytonaConfig } from "./validate.js";

/** Create a Daytona SandboxAdapter. */
export function createDaytonaAdapter(
  config: DaytonaAdapterConfig,
): Result<SandboxAdapter, KoiError> {
  const validated = validateDaytonaConfig(config);
  if (!validated.ok) return validated;

  const resolvedConfig = validated.value;

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
        const instance = createDaytonaInstance(sdkSandbox);
        if (_profile.nexusMounts !== undefined && _profile.nexusMounts.length > 0) {
          await mountNexusFuse(instance, _profile.nexusMounts);
        }
        return instance;
      },
    },
  };
}
