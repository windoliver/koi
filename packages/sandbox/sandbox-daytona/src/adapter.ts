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

      // Idempotency label per create attempt — see sandbox-e2b for rationale.
      const label = `koi-${crypto.randomUUID()}`;
      const opts: DaytonaCreateOpts = {
        apiKey: resolved.apiKey,
        target: resolved.target,
        label,
        ...(resolved.apiUrl !== undefined ? { apiUrl: resolved.apiUrl } : {}),
      };
      let sdk: Awaited<ReturnType<typeof resolved.client.createSandbox>>;
      try {
        sdk = await resolved.client.createSandbox(opts);
      } catch (e: unknown) {
        const cause = e instanceof Error ? e.message : String(e);
        throw new Error(
          `sandbox-daytona: createSandbox(label=${label}) failed: ${cause}. The ` +
            `provider MAY have provisioned a workspace before the call rejected; if ` +
            `a workspace with label "${label}" exists, revoke it out-of-band to ` +
            `avoid a billable leak. Retry only after confirming cleanup.`,
          { cause: e },
        );
      }
      // Runtime check for JS callers (TS types already require delete()).
      // The supportsWorkspaceDelete preflight already rejects most skew,
      // but a buggy/lying wrapper can still pass the flag check and return
      // a delete-less handle. We have no authoritative way to delete the
      // workspace out-of-band from inside this adapter, but we do attempt
      // sdk.close() best-effort: in some SDK versions close() really does
      // delete, in others it's a detach that leaks. Surfacing the gap
      // loudly is more useful than a silent leak; the error explicitly
      // tells operators to verify the workspace state out-of-band.
      // Bounded cleanup: a stalled provider call must not wedge create()
      // forever. After 10 s, surface indeterminate teardown so operators
      // know to verify the workspace out-of-band.
      const CLEANUP_TIMEOUT_MS = 10_000;
      type CleanupOutcome =
        | { readonly kind: "ok" }
        | { readonly kind: "err"; readonly e: unknown }
        | { readonly kind: "timeout" };
      async function boundedCleanup(call: () => Promise<void>): Promise<CleanupOutcome> {
        return Promise.race<CleanupOutcome>([
          call().then(
            () => ({ kind: "ok" }) as const,
            (e: unknown) => ({ kind: "err", e }) as const,
          ),
          new Promise((resolve) =>
            setTimeout(() => resolve({ kind: "timeout" } as const), CLEANUP_TIMEOUT_MS),
          ),
        ]);
      }
      if (typeof sdk.delete !== "function") {
        const closeOutcome = await boundedCleanup(() => sdk.close());
        let cleanupNote: string;
        if (closeOutcome.kind === "ok") {
          cleanupNote =
            "sdk.close() was invoked best-effort but may be a client-side " +
            "detach that leaves the workspace running";
        } else if (closeOutcome.kind === "timeout") {
          cleanupNote = `sdk.close() did not settle within ${CLEANUP_TIMEOUT_MS}ms — workspace state INDETERMINATE`;
        } else {
          cleanupNote = `sdk.close() also failed: ${closeOutcome.e instanceof Error ? closeOutcome.e.message : String(closeOutcome.e)}`;
        }
        throw new Error(
          "sandbox-daytona: createSandbox returned a handle without a callable " +
            "delete() method despite client.supportsWorkspaceDelete=true. The just-" +
            `provisioned workspace MAY have leaked (${cleanupNote}). Verify the ` +
            "workspace state out-of-band and fix the wrapper to honour its " +
            "delete-capability declaration.",
        );
      }
      // Postflight: exec() requires `commands.supportsMaxOutputBytes=true`.
      // If we let a handle through without it, every subsequent exec()
      // would hard-fail and the caller would be billed for an unusable
      // workspace. Tear down here so the capability gap surfaces before
      // any command can be dispatched.
      if (sdk.commands?.supportsMaxOutputBytes !== true) {
        const deleteOutcome = await boundedCleanup(() => sdk.delete());
        let cleanupNote: string;
        if (deleteOutcome.kind === "ok") {
          cleanupNote = "best-effort delete() succeeded";
        } else if (deleteOutcome.kind === "timeout") {
          cleanupNote = `delete() did not settle within ${CLEANUP_TIMEOUT_MS}ms — workspace state INDETERMINATE; verify out-of-band (label="${label}")`;
        } else {
          cleanupNote = `delete() also failed: ${deleteOutcome.e instanceof Error ? deleteOutcome.e.message : String(deleteOutcome.e)} — verify the workspace state out-of-band (label="${label}")`;
        }
        throw new Error(
          "sandbox-daytona: createSandbox returned a handle without commands.supportsMaxOutputBytes=true. " +
            "exec() requires server-side cap enforcement; without it, the SandboxExecOptions " +
            "1 MB default could not be honoured before unbounded output reached the host. " +
            `Refusing to return an unusable handle — ${cleanupNote}. Inject a cap-capable SDK wrapper.`,
        );
      }
      return createDaytonaInstance(sdk, extractProfileDefaults(profile));
    },
  };

  return { ok: true, value: adapter };
}
