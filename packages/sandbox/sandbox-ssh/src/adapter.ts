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
/**
 * Wrap a pooled SshClient as a SandboxInstance whose `destroy` evicts the
 * pool entry AND closes the connection. ALL wrappers returned from
 * `findOrCreate(scope, ...)` go through this — including the second-and-later
 * findOrCreate-with-same-scope path. Without this, a sibling wrapper could
 * call `client.end()` on the pooled connection while leaving the pool entry
 * pointing at a now-closed client; the next findOrCreate would hand out a
 * stale-client wrapper that fails on every operation.
 */
function wrapPooled(
  client: SshClient,
  scope: string,
  pool: Map<string, SshClient>,
): SandboxInstance {
  const instance = createSshInstance(client);
  const originalDestroy = instance.destroy;
  return {
    ...instance,
    destroy: async () => {
      // Only delete if the pool entry still points to OUR client — concurrent
      // findOrCreate may have already replaced it.
      if (pool.get(scope) === client) pool.delete(scope);
      await originalDestroy.call(instance);
    },
  };
}

async function connectFromProfile(
  config: SshAdapterConfig,
  profile: SandboxProfile,
): Promise<Result<SshClient, KoiError>> {
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

async function connectOrThrow(
  config: SshAdapterConfig,
  profile: SandboxProfile,
): Promise<SshClient> {
  const r = await connectFromProfile(config, profile);
  if (!r.ok) throw new Error(r.error.message, { cause: r.error });
  return r.value;
}

export function createSshAdapter(config: SshAdapterConfig): SandboxAdapter {
  const pool: Map<string, SshClient> = new Map();
  return {
    name: "@koi/sandbox-ssh",
    version: "0.1.0",
    capabilities: SANDBOX_SSH_CAPABILITIES,
    async create(profile) {
      return createSshInstance(await connectOrThrow(config, profile));
    },
    async findOrCreate(scope, profile) {
      const existing = pool.get(scope);
      if (existing !== undefined) return wrapPooled(existing, scope, pool);
      const client = await connectOrThrow(config, profile);
      pool.set(scope, client);
      return wrapPooled(client, scope, pool);
    },
  };
}

export type { SshAdapterConfig, SshClient, SshClientFactory } from "./types.js";
