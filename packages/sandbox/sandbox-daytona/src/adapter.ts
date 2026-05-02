import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createDaytonaInstance } from "./instance.js";
import {
  detectUnsupportedProfileFields,
  extractProfileDefaults,
  formatUnsupportedProfileError,
} from "./profile.js";
import type { DaytonaAdapterConfig, DaytonaCreateOpts } from "./types.js";
import { validateDaytonaConfig } from "./validate.js";

/**
 * Create a Daytona SandboxAdapter.
 *
 * Validates configuration synchronously. Each `create(profile)` call validates
 * the profile (fail-closed for unsupported isolation fields) and provisions a
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
    create: async (profile: SandboxProfile) => {
      const unsupported = detectUnsupportedProfileFields(profile);
      if (unsupported !== undefined) {
        throw new Error(formatUnsupportedProfileError(unsupported));
      }

      const opts: DaytonaCreateOpts = {
        apiKey: resolved.apiKey,
        target: resolved.target,
        ...(resolved.apiUrl !== undefined ? { apiUrl: resolved.apiUrl } : {}),
      };
      const sdk = await resolved.client.createSandbox(opts);
      // Fail fast on lifecycle capability mismatch BEFORE handing the
      // instance to callers. If we proceeded, the workspace would be live
      // and billable but unkillable: destroy() would later refuse without
      // sdk.delete, and close() may be a client-side detach that leaks the
      // remote workspace. Tear down what we just provisioned and surface
      // the misconfiguration immediately.
      if (sdk.delete === undefined) {
        try {
          await sdk.close();
        } catch {
          // Best-effort — even if close fails, the originating error is
          // the lifecycle gap, not the cleanup attempt.
        }
        throw new Error(
          "sandbox-daytona: createSandbox returned an SDK handle without delete(). " +
            "This adapter requires delete-capable wrappers because close() in several " +
            "Daytona SDK versions is a client-side detach that leaves the workspace " +
            "running and billable. The just-provisioned workspace was best-effort " +
            "closed; inject a delete-capable wrapper before retrying.",
        );
      }
      return createDaytonaInstance(sdk, extractProfileDefaults(profile));
    },
  };

  return { ok: true, value: adapter };
}
