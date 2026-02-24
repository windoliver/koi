/**
 * Daytona SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
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
  const client = config.client;

  return {
    ok: true,
    value: {
      name: "daytona",
      create: async (_profile: SandboxProfile) => {
        if (client !== undefined) {
          const opts: DaytonaCreateOpts = {
            apiKey: resolvedConfig.apiKey,
            apiUrl: resolvedConfig.apiUrl,
            target: resolvedConfig.target,
          };
          const sdkSandbox = await client.createSandbox(opts);
          return createDaytonaInstance(sdkSandbox);
        }

        throw new Error(
          "Daytona SDK client not provided. " +
            "Pass a client in DaytonaAdapterConfig for production use, " +
            "or use a mock client for testing.",
        );
      },
    },
  };
}
