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
      let sdk: Awaited<ReturnType<typeof resolved.client.createSandbox>>;
      try {
        sdk = await resolved.client.createSandbox(opts);
      } catch (e: unknown) {
        const cause = e instanceof Error ? e.message : String(e);
        throw new Error(
          `sandbox-e2b: createSandbox(label=${label}) failed: ${cause}. The provider ` +
            `MAY have provisioned a microVM before the call rejected; if a sandbox ` +
            `with label "${label}" exists, revoke it out-of-band to avoid a billable ` +
            `leak. Retry only after confirming the cleanup, otherwise the orphan ` +
            `will remain alongside any newly created sandbox.`,
          { cause: e },
        );
      }
      // Runtime teardown-capability check. The TS contract already requires
      // sdk.kill (E2bSdkSandbox), but a JS caller / version-skewed wrapper
      // could provision a real microVM and only surface the gap at destroy()
      // time, by which point the remote sandbox is already running. Best-
      // effort kill here so we either have a working teardown path or a
      // surfaced leak — never a deferred-leak surprise.
      if (typeof sdk.kill !== "function") {
        // We have nothing else to call; the gap IS the leak.
        throw new Error(
          "sandbox-e2b: createSandbox returned a handle without a callable kill() method. " +
            "destroy() has no programmatic teardown path, so the just-provisioned remote " +
            "sandbox MAY have leaked. Verify the sandbox state out-of-band and inject a " +
            "kill-capable SDK wrapper before retrying.",
        );
      }
      return createE2bInstance(sdk, extractProfileDefaults(profile));
    },
  };

  return { ok: true, value: adapter };
}
