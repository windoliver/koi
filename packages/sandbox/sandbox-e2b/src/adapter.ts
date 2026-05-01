import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createE2bInstance } from "./instance.js";
import type { E2bAdapterConfig, E2bCreateOpts } from "./types.js";
import { validateE2bConfig } from "./validate.js";

/**
 * Create an E2B SandboxAdapter.
 *
 * Validates configuration synchronously. Each `create()` call provisions a
 * fresh remote sandbox via the injected `E2bClient`.
 */
export function createE2bAdapter(config: E2bAdapterConfig): Result<SandboxAdapter, KoiError> {
  const validated = validateE2bConfig(config);
  if (!validated.ok) return validated;
  const resolved = validated.value;

  const adapter: SandboxAdapter = {
    name: "e2b",
    create: async (_profile: SandboxProfile) => {
      const opts: E2bCreateOpts = {
        apiKey: resolved.apiKey,
        ...(resolved.template !== undefined ? { template: resolved.template } : {}),
      };
      const sdk = await resolved.client.createSandbox(opts);
      return createE2bInstance(sdk);
    },
  };

  return { ok: true, value: adapter };
}
