import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createE2bInstance } from "./instance.js";
import {
  detectUnsupportedProfileFields,
  extractProfileDefaults,
  formatUnsupportedProfileError,
} from "./profile.js";
import type { E2bAdapterConfig, E2bCreateOpts } from "./types.js";
import { validateE2bConfig } from "./validate.js";

/**
 * Create an E2B SandboxAdapter.
 *
 * Validates configuration synchronously. Each `create(profile)` call validates
 * the profile against the hosted backend's supported feature set (fail-closed
 * for unsupported isolation fields) and provisions a fresh remote sandbox via
 * the injected `E2bClient`.
 */
export function createE2bAdapter(config: E2bAdapterConfig): Result<SandboxAdapter, KoiError> {
  const validated = validateE2bConfig(config);
  if (!validated.ok) return validated;
  const resolved = validated.value;

  // Preflight: refuse before provisioning if the client cannot guarantee
  // kill-capable handles. The TS contract requires `supportsTeardown: true`;
  // this runtime check is the defence-in-depth backstop for JS callers.
  if (resolved.client.supportsTeardown !== true) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "sandbox-e2b: E2bClient must declare supportsTeardown=true. Without an " +
          "up-front capability handshake the adapter would have to provision a " +
          "microVM before discovering it cannot be torn down, leaking a billable " +
          "sandbox per failed create. Inject a wrapper that asserts kill-capable " +
          "handles.",
        retryable: false,
      },
    };
  }

  const adapter: SandboxAdapter = {
    name: "e2b",
    create: async (profile: SandboxProfile) => {
      const unsupported = detectUnsupportedProfileFields(profile);
      if (unsupported !== undefined) {
        throw new Error(formatUnsupportedProfileError(unsupported));
      }

      // Generate an idempotency label per create attempt. The wrapper is
      // contracted to forward it to the provider; on ambiguous failure
      // (provider provisioned the microVM but the SDK call rejected before
      // returning a handle), the label is the only breadcrumb operators
      // have to find and revoke the orphan.
      const label = `koi-${crypto.randomUUID()}`;
      const opts: E2bCreateOpts = {
        apiKey: resolved.apiKey,
        label,
        ...(resolved.template !== undefined ? { template: resolved.template } : {}),
      };
      // Bounded provisioning: a stalled control plane must not wedge
      // create() forever. The provider may have allocated the microVM
      // before the SDK call lost the response, so surface the label
      // even on timeout so operators have a recovery breadcrumb.
      const CREATE_TIMEOUT_MS = 30_000;
      type CreateOutcome =
        | {
            readonly kind: "ok";
            readonly sdk: Awaited<ReturnType<typeof resolved.client.createSandbox>>;
          }
        | { readonly kind: "err"; readonly e: unknown }
        | { readonly kind: "timeout" };
      const createPromise = resolved.client.createSandbox(opts);
      const outcome = await Promise.race<CreateOutcome>([
        createPromise.then(
          (s): CreateOutcome => ({ kind: "ok", sdk: s }),
          (e: unknown): CreateOutcome => ({ kind: "err", e }),
        ),
        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" } as const), CREATE_TIMEOUT_MS),
        ),
      ]);
      if (outcome.kind === "timeout") {
        // Late-cleanup reconciler: keep ownership of the in-flight
        // create. If the provider eventually returns a handle (after we
        // already surfaced the timeout to the caller), best-effort kill
        // the orphan microVM. Without this, retries accumulate billable
        // leaks during a control-plane latency spike.
        createPromise.then(
          (lateSdk) => {
            if (typeof lateSdk?.kill === "function") {
              lateSdk.kill().catch(() => {
                // Best-effort: orphan label is already in the surfaced
                // error so operators can revoke out-of-band.
              });
            }
          },
          () => {
            // Original create rejected after the timeout window; nothing
            // to clean up.
          },
        );
        throw new Error(
          `sandbox-e2b: createSandbox(label=${label}) did not settle within ` +
            `${CREATE_TIMEOUT_MS}ms — provisioning state INDETERMINATE. The adapter ` +
            `will best-effort kill any microVM that arrives late, but if the SDK ` +
            `never returns a handle, search for label "${label}" out-of-band to ` +
            `revoke any orphan before retrying.`,
        );
      }
      if (outcome.kind === "err") {
        const cause = outcome.e instanceof Error ? outcome.e.message : String(outcome.e);
        throw new Error(
          `sandbox-e2b: createSandbox(label=${label}) failed: ${cause}. The provider ` +
            `MAY have provisioned a microVM before the call rejected; if a sandbox ` +
            `with label "${label}" exists, revoke it out-of-band to avoid a billable ` +
            `leak. Retry only after confirming the cleanup, otherwise the orphan ` +
            `will remain alongside any newly created sandbox.`,
          { cause: outcome.e },
        );
      }
      const sdk = outcome.sdk;
      // Runtime teardown-capability check. The TS contract already requires
      // sdk.kill (E2bSdkSandbox), but a JS caller / version-skewed wrapper
      // could provision a real microVM and only surface the gap at destroy()
      // time, by which point the remote sandbox is already running. Best-
      // effort kill here so we either have a working teardown path or a
      // surfaced leak — never a deferred-leak surprise.
      if (typeof sdk.kill !== "function") {
        // We have nothing else to call; the gap IS the leak. Surface
        // the per-attempt label so operators can locate the orphan via
        // the same recovery workflow used for ambiguous create failures.
        throw new Error(
          `sandbox-e2b: createSandbox(label=${label}) returned a handle without a ` +
            "callable kill() method. destroy() has no programmatic teardown path, so " +
            `the just-provisioned remote sandbox MAY have leaked. Search for label ` +
            `"${label}" out-of-band to revoke the orphan, and inject a kill-capable ` +
            "SDK wrapper before retrying.",
        );
      }
      // Postflight: the instance contract makes `commands.supportsMaxOutputBytes=true`
      // mandatory at exec() time. If we let a handle through without it,
      // every subsequent exec() would hard-fail and the caller would be
      // billed for an unusable sandbox. Tear down here instead so the
      // capability gap surfaces before any caller can dispatch a command.
      if (sdk.commands?.supportsMaxOutputBytes !== true) {
        // Bounded cleanup: a stalled sdk.kill() must not wedge create()
        // forever. After 10 s, surface the indeterminate teardown so
        // operators know to verify the sandbox out-of-band.
        const CLEANUP_TIMEOUT_MS = 10_000;
        const cleanupOutcome = await Promise.race<
          | { readonly kind: "ok" }
          | { readonly kind: "err"; readonly e: unknown }
          | { readonly kind: "timeout" }
        >([
          sdk.kill().then(
            () => ({ kind: "ok" }) as const,
            (e: unknown) => ({ kind: "err", e }) as const,
          ),
          new Promise((resolve) =>
            setTimeout(() => resolve({ kind: "timeout" } as const), CLEANUP_TIMEOUT_MS),
          ),
        ]);
        let cleanupNote: string;
        if (cleanupOutcome.kind === "ok") {
          cleanupNote = "best-effort kill() succeeded";
        } else if (cleanupOutcome.kind === "timeout") {
          cleanupNote = `kill() did not settle within ${CLEANUP_TIMEOUT_MS}ms — remote sandbox state INDETERMINATE; verify out-of-band (label="${label}")`;
        } else {
          const e = cleanupOutcome.e;
          cleanupNote = `kill() also failed: ${e instanceof Error ? e.message : String(e)} — verify the sandbox state out-of-band (label="${label}")`;
        }
        throw new Error(
          "sandbox-e2b: createSandbox returned a handle without commands.supportsMaxOutputBytes=true. " +
            "exec() requires server-side cap enforcement; without it, the SandboxExecOptions " +
            "1 MB default could not be honoured before unbounded output reached the host. " +
            `Refusing to return an unusable handle — ${cleanupNote}. Inject a cap-capable SDK wrapper.`,
        );
      }
      return createE2bInstance(sdk, extractProfileDefaults(profile));
    },
  };

  return { ok: true, value: adapter };
}
