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

  // Preflight: if the injected client cannot guarantee delete-capable
  // handles, refuse before we ever provision a workspace. The TS contract
  // requires `supportsWorkspaceDelete: true`; this runtime check is the
  // defence-in-depth backstop for JS callers.
  if (resolved.client.supportsWorkspaceDelete !== true) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "sandbox-daytona: DaytonaClient must declare supportsWorkspaceDelete=true. " +
          "Without an up-front capability handshake the adapter would have to provision " +
          "a workspace before discovering it cannot be deleted, leaking a billable " +
          "workspace per failed create. Inject a wrapper that asserts true workspace " +
          "deletion (not client-side detach via close()).",
        retryable: false,
      },
    };
  }

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
      // Runtime check for JS callers (TS types already require delete()).
      // We deliberately do NOT call sdk.close() on failure: in several
      // Daytona SDK versions close() is a client-side detach that leaves
      // the remote workspace running and billable, so attempting it would
      // hide the leak instead of preventing it. Surface the lifecycle gap
      // loudly so operators can revoke the workspace out-of-band; do not
      // pretend to clean up.
      if (typeof sdk.delete !== "function") {
        throw new Error(
          "sandbox-daytona: createSandbox returned an SDK handle without a callable " +
            "delete() method. This adapter requires delete-capable wrappers because " +
            "close() in several Daytona SDK versions is a client-side detach that " +
            "leaves the remote workspace running and billable; falling back to it " +
            "would silently leak. The workspace just provisioned cannot be safely " +
            "torn down through this client — revoke it out-of-band and inject a " +
            "delete-capable wrapper before retrying.",
        );
      }
      return createDaytonaInstance(sdk, extractProfileDefaults(profile));
    },
  };

  return { ok: true, value: adapter };
}
