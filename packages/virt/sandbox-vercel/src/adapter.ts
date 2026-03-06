/**
 * Vercel SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "@koi/sandbox-cloud-base";
import { createVercelInstance } from "./instance.js";
import type { VercelAdapterConfig, VercelCreateOpts } from "./types.js";
import { validateVercelConfig } from "./validate.js";

/** Create a Vercel SandboxAdapter. */
export function createVercelAdapter(config: VercelAdapterConfig): Result<SandboxAdapter, KoiError> {
  const validated = validateVercelConfig(config);
  if (!validated.ok) return validated;

  const resolvedConfig = validated.value;

  return {
    ok: true,
    value: {
      name: "vercel",
      create: async (_profile: SandboxProfile) => {
        const unsupported = detectUnsupportedProfileFields(_profile);
        if (unsupported !== undefined) {
          throw new Error(formatUnsupportedProfileError("Vercel", unsupported));
        }

        const opts: VercelCreateOpts = {
          apiToken: resolvedConfig.apiToken,
          ...(resolvedConfig.teamId !== undefined ? { teamId: resolvedConfig.teamId } : {}),
          ...(resolvedConfig.projectId !== undefined
            ? { projectId: resolvedConfig.projectId }
            : {}),
        };
        const sdkSandbox = await resolvedConfig.client.createSandbox(opts);
        return createVercelInstance(sdkSandbox);
      },
    },
  };
}
