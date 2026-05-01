import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createDaytonaInstance } from "./instance.js";
import type { DaytonaAdapterConfig, DaytonaCreateOpts } from "./types.js";
import { validateDaytonaConfig } from "./validate.js";

/**
 * Create a Daytona SandboxAdapter.
 *
 * Validates configuration synchronously. Each `create()` call provisions a
 * fresh Daytona workspace via the injected `DaytonaClient`.
 */
export function createDaytonaAdapter(
  config: DaytonaAdapterConfig,
): Result<SandboxAdapter, KoiError> {
  const validated = validateDaytonaConfig(config);
  if (!validated.ok) return validated;
  const resolved = validated.value;

  const adapter: SandboxAdapter = {
    name: "daytona",
    create: async (_profile: SandboxProfile) => {
      const opts: DaytonaCreateOpts = {
        apiKey: resolved.apiKey,
        target: resolved.target,
        ...(resolved.apiUrl !== undefined ? { apiUrl: resolved.apiUrl } : {}),
      };
      const sdk = await resolved.client.createSandbox(opts);
      return createDaytonaInstance(sdk);
    },
  };

  return { ok: true, value: adapter };
}
