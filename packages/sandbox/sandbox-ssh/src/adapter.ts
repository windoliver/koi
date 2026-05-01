import type {
  AdapterCapabilities,
  AdapterCapability,
  KoiError,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { createSshInstance } from "./instance.js";
import type { SshAdapterConfig, SshClient } from "./types.js";

const SANDBOX_SSH_SUPPORTED: ReadonlySet<AdapterCapability> = new Set<AdapterCapability>([
  "exec",
  "copy-files",
  "persistence",
  "network",
]);

const SANDBOX_SSH_CAPABILITIES: AdapterCapabilities = {
  supports: SANDBOX_SSH_SUPPORTED,
  priority: 20,
};

/**
 * Create a SandboxAdapter that opens SSH connections per `create()` call and
 * tracks them by scope key for `findOrCreate` reuse. Closing happens via
 * `instance.destroy()` (or the caller calling the adapter's optional pool
 * teardown — currently not exposed; pool entries persist for the lifetime of
 * the process).
 *
 * `profile.ssh` MUST be set on every profile passed to `create()`. Profiles
 * without `ssh` are rejected with a typed `VALIDATION` error.
 *
 * `filesystem-rw` is NOT declared because remote write authority depends on
 * the SSH user's permissions, not the adapter — declaring it here would lie
 * about a guarantee we can't enforce.
 */
export function createSshAdapter(config: SshAdapterConfig): SandboxAdapter {
  const pool: Map<string, SshClient> = new Map();

  async function connectFromProfile(profile: SandboxProfile): Promise<Result<SshClient, KoiError>> {
    const target = profile.ssh;
    if (target === undefined) {
      const error: KoiError = {
        code: "VALIDATION",
        message: "sandbox-ssh: profile.ssh is required",
        retryable: false,
      };
      return { ok: false, error };
    }
    try {
      const client = await config.clientFactory.connect(target);
      return { ok: true, value: client };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `sandbox-ssh: failed to connect to ${target.user}@${target.host}`,
          retryable: false,
          cause: err,
        },
      };
    }
  }

  return {
    name: "@koi/sandbox-ssh",
    version: "0.1.0",
    capabilities: SANDBOX_SSH_CAPABILITIES,
    async create(profile: SandboxProfile): Promise<SandboxInstance> {
      const r = await connectFromProfile(profile);
      if (!r.ok) {
        throw new Error(r.error.message, { cause: r.error });
      }
      return createSshInstance(r.value);
    },
    async findOrCreate(scope: string, profile: SandboxProfile): Promise<SandboxInstance> {
      const existing = pool.get(scope);
      if (existing !== undefined) {
        return createSshInstance(existing);
      }
      const r = await connectFromProfile(profile);
      if (!r.ok) {
        throw new Error(r.error.message, { cause: r.error });
      }
      pool.set(scope, r.value);
      // The pool retains the connection; instance.destroy will close it AND
      // remove the pool entry to avoid handing out a closed client next time.
      const instance = createSshInstance(r.value);
      const originalDestroy = instance.destroy;
      return {
        ...instance,
        destroy: async () => {
          pool.delete(scope);
          await originalDestroy.call(instance);
        },
      };
    },
  };
}

export type { SshAdapterConfig, SshClient, SshClientFactory } from "./types.js";
