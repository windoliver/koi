import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { NexusVersionTag } from "./types.js";

export interface NexusPermissionBackendConfig {
  readonly transport: NexusTransport;
  readonly localBackend: PermissionBackend;
  readonly getCurrentPolicy: () => unknown;
  readonly rebuildBackend: (policy: unknown) => PermissionBackend;
  readonly syncIntervalMs?: number | undefined;
  readonly policyPath?: string | undefined;
}

export interface NexusPermissionBackend extends PermissionBackend {
  /** Always defined — delegates to local backend's checkBatch or falls back to sequential checks. */
  readonly checkBatch: (
    queries: readonly PermissionQuery[],
  ) => Promise<readonly PermissionDecision[]>;
  readonly dispose: () => void;
  /** @internal Exposed for testing poll logic without real timers. */
  readonly _poll: () => Promise<void>;
}

const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const DEFAULT_POLICY_PATH = "koi/permissions";

export function createNexusPermissionBackend(
  config: NexusPermissionBackendConfig,
): NexusPermissionBackend {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;
  const syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;

  // let justified: mutable local backend — replaced atomically on sync
  let localBackend = config.localBackend;
  // let justified: last-seen version tag for cheap poll comparison
  let lastSeenVersion = -1;
  // let justified: lifecycle flags
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  async function writeCurrentPolicy(): Promise<void> {
    const policy = config.getCurrentPolicy();
    await config.transport.call("write", {
      path: `${policyPath}/policy.json`,
      content: JSON.stringify(policy),
    });
    const newVersion = lastSeenVersion + 1;
    await config.transport.call("write", {
      path: `${policyPath}/version.json`,
      content: JSON.stringify({
        version: newVersion,
        updatedAt: Date.now(),
      } satisfies NexusVersionTag),
    });
    lastSeenVersion = newVersion;
  }

  async function initializePolicy(): Promise<void> {
    const versionResult = await config.transport.call<string>("read", {
      path: `${policyPath}/version.json`,
    });

    if (!versionResult.ok) {
      // Nexus unreachable or no policy — write current local policy (best-effort)
      await writeCurrentPolicy().catch(() => {});
      return;
    }

    const policyResult = await config.transport.call<string>("read", {
      path: `${policyPath}/policy.json`,
    });
    if (!policyResult.ok) return;

    try {
      const tag = JSON.parse(versionResult.value) as NexusVersionTag;
      const policy: unknown = JSON.parse(policyResult.value);
      localBackend = config.rebuildBackend(policy);
      lastSeenVersion = tag.version;
    } catch {
      console.warn("[permissions-nexus] malformed Nexus policy on startup, using local rules");
    }
  }

  async function poll(): Promise<void> {
    const versionResult = await config.transport.call<string>("read", {
      path: `${policyPath}/version.json`,
    });
    if (!versionResult.ok) return;

    let tag: NexusVersionTag;
    try {
      tag = JSON.parse(versionResult.value) as NexusVersionTag;
    } catch {
      return;
    }
    if (tag.version === lastSeenVersion) return;

    const policyResult = await config.transport.call<string>("read", {
      path: `${policyPath}/policy.json`,
    });
    if (!policyResult.ok) return;

    try {
      const policy: unknown = JSON.parse(policyResult.value);
      localBackend = config.rebuildBackend(policy);
      lastSeenVersion = tag.version;
    } catch {
      console.warn("[permissions-nexus] malformed Nexus policy during sync, skipping update");
    }
  }

  function startPolling(): void {
    if (syncIntervalMs === 0 || disposed) return;
    timer = setInterval(() => {
      void poll().catch(() => {}); // non-fatal
    }, syncIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  // Fire-and-forget startup: init then start polling
  void initializePolicy()
    .catch(() => {
      console.warn("[permissions-nexus] startup Nexus sync failed, running on local rules");
    })
    .finally(() => {
      if (!disposed) startPolling();
    });

  function check(query: PermissionQuery): PermissionDecision | Promise<PermissionDecision> {
    return localBackend.check(query);
  }

  function checkBatch(queries: readonly PermissionQuery[]): Promise<readonly PermissionDecision[]> {
    if (localBackend.checkBatch !== undefined) {
      return Promise.resolve(localBackend.checkBatch(queries));
    }
    return Promise.all(queries.map((q) => Promise.resolve(localBackend.check(q))));
  }

  function dispose(): void {
    disposed = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    void localBackend.dispose?.();
  }

  const base: NexusPermissionBackend = {
    check,
    checkBatch,
    dispose,
    _poll: poll,
  };

  if (config.localBackend.supportsDefaultDenyMarker !== undefined) {
    return {
      ...base,
      supportsDefaultDenyMarker: config.localBackend.supportsDefaultDenyMarker,
    };
  }

  return base;
}
