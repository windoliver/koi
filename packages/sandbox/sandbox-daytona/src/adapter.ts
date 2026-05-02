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
      // Bounded provisioning: a stalled control plane must not wedge
      // create() forever. Surface the label even on timeout so
      // operators have a recovery breadcrumb for any orphan.
      const CREATE_TIMEOUT_MS = 30_000;
      type CreateOutcome =
        | {
            readonly kind: "ok";
            readonly sdk: Awaited<ReturnType<typeof resolved.client.createSandbox>>;
          }
        | { readonly kind: "err"; readonly e: unknown }
        | { readonly kind: "timeout" };
      const createPromise = resolved.client.createSandbox(opts);
      const createOutcome = await Promise.race<CreateOutcome>([
        createPromise.then(
          (s): CreateOutcome => ({ kind: "ok", sdk: s }),
          (e: unknown): CreateOutcome => ({ kind: "err", e }),
        ),
        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" } as const), CREATE_TIMEOUT_MS),
        ),
      ]);
      if (createOutcome.kind === "timeout") {
        // Late-cleanup reconciler: keep ownership of the in-flight
        // create. If the provider eventually returns a handle, best-
        // effort delete the orphan workspace. Without this, retries
        // accumulate billable leaks during a control-plane latency spike.
        createPromise.then(
          (lateSdk) => {
            if (typeof lateSdk?.delete === "function") {
              lateSdk.delete().catch(() => {});
            } else if (typeof lateSdk?.close === "function") {
              // delete() is the authoritative path; close() is best-
              // effort and may only detach. Fall back if delete is
              // missing — at least it doesn't leave the workspace running
              // in some SDK versions.
              lateSdk.close().catch(() => {});
            }
          },
          () => {
            // Original create rejected after the timeout window.
          },
        );
        throw new Error(
          `sandbox-daytona: createSandbox(label=${label}) did not settle within ` +
            `${CREATE_TIMEOUT_MS}ms — provisioning state INDETERMINATE. The adapter ` +
            `will best-effort delete any workspace that arrives late, but if the SDK ` +
            `never returns a handle, search for label "${label}" out-of-band to ` +
            `revoke any orphan before retrying.`,
        );
      }
      if (createOutcome.kind === "err") {
        const cause =
          createOutcome.e instanceof Error ? createOutcome.e.message : String(createOutcome.e);
        throw new Error(
          `sandbox-daytona: createSandbox(label=${label}) failed: ${cause}. The ` +
            `provider MAY have provisioned a workspace before the call rejected; if ` +
            `a workspace with label "${label}" exists, revoke it out-of-band to ` +
            `avoid a billable leak. Retry only after confirming cleanup.`,
          { cause: createOutcome.e },
        );
      }
      const sdk = createOutcome.sdk;
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
          `sandbox-daytona: createSandbox(label=${label}) returned a handle without ` +
            "a callable delete() method despite client.supportsWorkspaceDelete=true. " +
            `The just-provisioned workspace MAY have leaked (${cleanupNote}). Search ` +
            `for label "${label}" out-of-band to revoke the orphan, and fix the ` +
            "wrapper to honour its delete-capability declaration.",
        );
      }
      // Postflight: exec() requires `commands.supportsMaxOutputBytes=true`.
      // If we let a handle through without it, every subsequent exec()
      // would hard-fail and the caller would be billed for an unusable
      // workspace. Tear down here so the capability gap surfaces before
      // any command can be dispatched.
      async function deleteAndDescribe(): Promise<string> {
        const deleteOutcome = await boundedCleanup(() => sdk.delete());
        if (deleteOutcome.kind === "ok") return "best-effort delete() succeeded";
        if (deleteOutcome.kind === "timeout") {
          return `delete() did not settle within ${CLEANUP_TIMEOUT_MS}ms — workspace state INDETERMINATE; verify out-of-band (label="${label}")`;
        }
        return `delete() also failed: ${deleteOutcome.e instanceof Error ? deleteOutcome.e.message : String(deleteOutcome.e)} — verify the workspace state out-of-band (label="${label}")`;
      }

      if (sdk.commands?.supportsMaxOutputBytes !== true) {
        const cleanupNote = await deleteAndDescribe();
        throw new Error(
          "sandbox-daytona: createSandbox returned a handle without commands.supportsMaxOutputBytes=true. " +
            "exec() requires server-side cap enforcement; without it, the SandboxExecOptions " +
            "1 MB default could not be honoured before unbounded output reached the host. " +
            `Refusing to return an unusable handle — ${cleanupNote}. Inject a cap-capable SDK wrapper.`,
        );
      }
      // Postflight: the SandboxInstance contract advertises byte-oriented
      // readFile/writeFile. A handle without `files.readBytes` would
      // hard-fail every readFile() after we already started billing for
      // the workspace; a handle without `files.writeBytes` would silently
      // corrupt non-UTF-8 payloads on writeFile(). Tear down here so the
      // capability gap surfaces before the caller pays.
      if (typeof sdk.files?.readBytes !== "function") {
        const cleanupNote = await deleteAndDescribe();
        throw new Error(
          "sandbox-daytona: createSandbox returned a handle without files.readBytes. " +
            "SandboxInstance.readFile is byte-oriented and the text-only fallback " +
            "would corrupt non-UTF-8 payloads on re-encode. Refusing to return an " +
            `unusable handle — ${cleanupNote}. Inject an SDK wrapper that exposes readBytes.`,
        );
      }
      if (typeof sdk.files?.writeBytes !== "function") {
        const cleanupNote = await deleteAndDescribe();
        throw new Error(
          "sandbox-daytona: createSandbox returned a handle without files.writeBytes. " +
            "SandboxInstance.writeFile must accept arbitrary bytes; a text-only fallback " +
            "would reject non-UTF-8 input only after the caller already paid for the " +
            `workspace. Refusing to return an unusable handle — ${cleanupNote}. Inject an ` +
            "SDK wrapper that exposes writeBytes.",
        );
      }
      return createDaytonaInstance(sdk, extractProfileDefaults(profile));
    },
  };

  return { ok: true, value: adapter };
}
