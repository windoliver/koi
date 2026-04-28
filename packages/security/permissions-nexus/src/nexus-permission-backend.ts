import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";
import { extractReadContent, type NexusTransport } from "@koi/nexus-client";
import type { NexusVersionTag } from "./types.js";

export interface NexusPermissionBackendConfig {
  readonly transport: NexusTransport;
  readonly localBackend: PermissionBackend;
  readonly rebuildBackend: (policy: unknown) => PermissionBackend;
  readonly syncIntervalMs?: number | undefined;
  readonly policyPath?: string | undefined;
  /**
   * Per-call deadline applied to each `read` during the initial policy sync.
   * Threaded into `transport.call(...)` so the assert-remote-policy-loaded
   * boot mode can bound startup duration. Falls back to the transport's
   * default when undefined.
   */
  readonly bootSyncDeadlineMs?: number | undefined;
}

export interface NexusPermissionBackend extends PermissionBackend {
  /**
   * Resolves when the initial Nexus policy sync completes (or falls back to local).
   * Await before first use if you need the remote policy applied before any check().
   */
  readonly ready: Promise<void>;
  /** Always defined — delegates to local backend's checkBatch or falls back to sequential checks. */
  readonly checkBatch: (
    queries: readonly PermissionQuery[],
  ) => Promise<readonly PermissionDecision[]>;
  readonly dispose: () => void;
  /**
   * True iff the initial sync produced a centralized policy that was actually
   * activated (rebuildBackend succeeded AND supportsDefaultDenyMarker matched).
   * False if `ready` resolved via local-fallback (transport error, 404,
   * malformed policy, marker mismatch). Used by `assert-remote-policy-loaded
   * -at-boot` to gate startup AFTER awaiting `ready`.
   */
  readonly isCentralizedPolicyActive: () => boolean;
  /**
   * Aborts an in-flight initial sync. Sets the mutation guard so any late
   * `initializePolicy()` resolution after dispose CANNOT mutate state. The
   * caller-bounded JS-side wait in `assert-remote-policy-loaded-at-boot` uses
   * this on deadline expiry. On local-bridge this delivers state-correctness
   * via the mutation guard but does not shorten Python read latency.
   */
  readonly abortInFlightSync: () => void;
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
  // let justified: mutation guard — set by abortInFlightSync()/dispose() to
  // reject late initializePolicy()/doPoll() resolutions that arrive after
  // the runtime has decided to bail (e.g., assert-remote-policy-loaded-at-boot
  // deadline expired). Local-bridge cannot shorten the in-flight Python read,
  // but this guard guarantees state-correctness when the late reply lands.
  let syncAborted = false;
  // let justified: tracks whether initial sync activated a centralized policy
  let centralizedPolicyActive = false;
  const bootCallOpts =
    config.bootSyncDeadlineMs !== undefined ? { deadlineMs: config.bootSyncDeadlineMs } : undefined;

  function extractString(value: unknown): string {
    const r = extractReadContent(value);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }

  async function initializePolicy(): Promise<void> {
    const versionResult = await config.transport.call<unknown>(
      "read",
      { path: `${policyPath}/version.json` },
      bootCallOpts,
    );
    if (syncAborted) return;

    if (!versionResult.ok) {
      if (versionResult.error.code === "NOT_FOUND") {
        // Fresh Nexus store: no version.json found. Running on local policy only.
        // This node will NOT sync permissions with other nodes until version.json
        // is created externally. Bootstrap Nexus with a seeded policy.json + version.json
        // to enable cross-node sync. The poller will pick it up once seeded.
        console.warn(
          "[permissions-nexus] version.json missing — running on local policy. " +
            "Bootstrap Nexus to enable cross-node permission sync.",
        );
      }
      // Any error: run local-only; poller retries on interval.
      // Do NOT write to Nexus here — concurrent nodes starting simultaneously
      // would race with no CAS guarantee, risking policy divergence.
      return;
    }

    const policyResult = await config.transport.call<unknown>(
      "read",
      { path: `${policyPath}/policy.json` },
      bootCallOpts,
    );
    if (syncAborted) return;
    if (!policyResult.ok) return;

    try {
      const tag = JSON.parse(extractString(versionResult.value)) as NexusVersionTag;
      const policy: unknown = JSON.parse(extractString(policyResult.value));
      const rebuiltBackend = config.rebuildBackend(policy);
      if (
        rebuiltBackend.supportsDefaultDenyMarker !== config.localBackend.supportsDefaultDenyMarker
      ) {
        console.warn(
          "[permissions-nexus] rebuilt backend supportsDefaultDenyMarker mismatch on startup — skipping policy activation",
        );
        return;
      }
      if (syncAborted) return;
      localBackend = rebuiltBackend;
      lastSeenVersion = tag.version;
      centralizedPolicyActive = true;
    } catch {
      console.warn("[permissions-nexus] malformed Nexus policy on startup, using local rules");
    }
  }

  // let justified: in-flight poll promise to prevent concurrent overlapping polls
  let pollInFlight: Promise<void> | undefined;

  async function poll(): Promise<void> {
    if (pollInFlight !== undefined) return; // skip if already polling
    pollInFlight = doPoll().finally(() => {
      pollInFlight = undefined;
    });
    return pollInFlight;
  }

  async function doPoll(): Promise<void> {
    const versionResult = await config.transport.call<unknown>("read", {
      path: `${policyPath}/version.json`,
    });
    if (!versionResult.ok) return;

    let tag: NexusVersionTag;
    try {
      tag = JSON.parse(extractString(versionResult.value)) as NexusVersionTag;
    } catch {
      return;
    }
    if (tag.version <= lastSeenVersion) return; // monotonicity: discard stale results

    const policyResult = await config.transport.call<unknown>("read", {
      path: `${policyPath}/policy.json`,
    });
    if (!policyResult.ok) return;

    try {
      const policy: unknown = JSON.parse(extractString(policyResult.value));
      const rebuiltBackend = config.rebuildBackend(policy);
      // Re-check version monotonicity after async fetch — another poll may have applied newer
      if (tag.version > lastSeenVersion) {
        if (
          rebuiltBackend.supportsDefaultDenyMarker !== config.localBackend.supportsDefaultDenyMarker
        ) {
          console.warn(
            "[permissions-nexus] rebuilt backend supportsDefaultDenyMarker mismatch during sync — skipping policy update",
          );
          return;
        }
        if (disposed) return;
        localBackend = rebuiltBackend;
        lastSeenVersion = tag.version;
        centralizedPolicyActive = true;
      }
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

  // Startup: init then start polling; expose as `ready` so callers can await before first use
  const ready: Promise<void> = initializePolicy()
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
    syncAborted = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    void localBackend.dispose?.();
  }

  function abortInFlightSync(): void {
    syncAborted = true;
  }

  function isCentralizedPolicyActive(): boolean {
    return centralizedPolicyActive;
  }

  const base: NexusPermissionBackend = {
    check,
    checkBatch,
    dispose,
    ready,
    abortInFlightSync,
    isCentralizedPolicyActive,
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
