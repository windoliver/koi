/**
 * E2B SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
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
  const client = config.client;

  return {
    ok: true,
    value: {
      name: "e2b",
      create: async (_profile: SandboxProfile) => {
        if (client !== undefined) {
          const opts: E2bCreateOpts = {
            apiKey: resolvedConfig.apiKey,
            ...(resolvedConfig.template !== undefined ? { template: resolvedConfig.template } : {}),
          };
          const sdkSandbox = await client.createSandbox(opts);
          return createE2bInstance(sdkSandbox);
        }

        throw new Error(
          "E2B SDK client not provided. " +
            "Pass a client in E2bAdapterConfig for production use, " +
            "or use a mock client for testing.",
        );
      },
    },
  };
}
