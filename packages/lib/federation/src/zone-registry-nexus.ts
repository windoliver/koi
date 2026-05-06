/**
 * Nexus-backed ZoneRegistry implementation.
 *
 * Uses NexusTransport JSON-RPC to manage zone lifecycle on a Nexus server.
 *
 * Read semantics (`lookup`, `list`) follow `serverReadsMode`:
 *   - `"auto"` (default): query the hub first via
 *     `federation.zone_lookup` / `federation.zone_list`. If the hub
 *     responds with a method-not-found-style error, this registry
 *     downgrades to writer-local projection for the rest of its
 *     lifetime so the call still returns. New/restarted processes get
 *     authoritative discovery against upgraded hubs without breaking
 *     against pre-v1 hubs that haven't shipped the read handlers.
 *   - `"always"`: always query the hub; method-not-found surfaces as
 *     a hard error (use after the rolling upgrade is complete).
 *   - `"never"`: always read from the writer-local projection (legacy
 *     baseline mode).
 *
 * The local projection is kept in lockstep with this writer's own
 * `register()`/`deregister()` calls regardless of mode, so it powers
 * `watch()` events and the `"never"`/downgraded reads.
 */

import type { ZoneDescriptor, ZoneEvent, ZoneFilter, ZoneId, ZoneRegistry } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

/** Strategy for `lookup()`/`list()` reads — see header docstring. */
export type ServerReadsMode = "auto" | "always" | "never";

/** Config for createZoneRegistryNexus. */
export interface ZoneRegistryNexusConfig {
  readonly transport: NexusTransport;
  /**
   * Read mode for `lookup()` and `list()`. Defaults to `"auto"` —
   * queries the hub first and silently downgrades to writer-local
   * projection for this registry's lifetime if the hub responds with
   * a method-not-found-style error. See header docstring.
   */
  readonly serverReadsMode?: ServerReadsMode;
  /**
   * Legacy boolean alias for `serverReadsMode`:
   *   - `true`  → `"always"`
   *   - `false` → `"never"`
   * Prefer `serverReadsMode`. Ignored if `serverReadsMode` is set.
   */
  readonly useServerReads?: boolean;
}

/**
 * Heuristic: does this transport error indicate the remote method is
 * not implemented? JSON-RPC servers signal this with code -32601, but
 * `NexusTransport` returns a `KoiError` whose code is `"EXTERNAL"`,
 * so we additionally pattern-match the message for the standard
 * phrases ("method not found", "unknown method", "not implemented").
 * False positives are bounded — the worst case is a transient error
 * that downgrades reads to projection, which is still a safer mode
 * than throwing on every read.
 */
function isMethodNotFoundError(message: string, code: string): boolean {
  if (code === "NOT_FOUND") return true;
  const m = message.toLowerCase();
  return (
    m.includes("method not found") ||
    m.includes("unknown method") ||
    m.includes("not implemented") ||
    m.includes("-32601")
  );
}

const ZONE_STATUSES: ReadonlySet<string> = new Set(["active", "draining", "offline"]);

/**
 * Strict type guard for `ZoneDescriptor` payloads from Nexus. All
 * required fields are validated; metadata, if present, must be a
 * plain object. Anything weaker would let schema drift or a buggy
 * peer poison discovery state without tripping a hard failure —
 * which is the wrong direction for federation control-plane data.
 */
function isZoneDescriptor(value: unknown): value is ZoneDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["zoneId"] !== "string" || candidate["zoneId"].length === 0) return false;
  if (typeof candidate["displayName"] !== "string") return false;
  if (typeof candidate["status"] !== "string" || !ZONE_STATUSES.has(candidate["status"])) {
    return false;
  }
  if (
    typeof candidate["registeredAt"] !== "number" ||
    !Number.isFinite(candidate["registeredAt"])
  ) {
    return false;
  }
  if (candidate["metadata"] !== undefined) {
    const meta = candidate["metadata"];
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return false;
  }
  return true;
}

/**
 * Creates a ZoneRegistry backed by a Nexus JSON-RPC server.
 *
 * Pattern: follows @koi/permissions-nexus — inject NexusTransport, call transport.call<T>().
 */
export function createZoneRegistryNexus(config: ZoneRegistryNexusConfig): ZoneRegistry {
  const { transport } = config;
  // let: serverReadsMode may auto-downgrade to "never" when the hub
  // signals method-not-found, so subsequent reads skip the RPC.
  let mode: ServerReadsMode =
    config.serverReadsMode ??
    (config.useServerReads === true
      ? "always"
      : config.useServerReads === false
        ? "never"
        : "auto");

  // In-memory projection for fast reads
  const projection = new Map<string, ZoneDescriptor>();
  // let: reassigned on subscribe/unsubscribe (immutable swap pattern)
  let listeners: ReadonlySet<(event: ZoneEvent) => void> = new Set();

  function notify(event: ZoneEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (_: unknown) {
        // Listener errors must not disrupt registry operations.
      }
    }
  }

  return {
    register: async (descriptor) => {
      const result = await transport.call<ZoneDescriptor>("federation.zone_register", {
        zoneId: descriptor.zoneId,
        displayName: descriptor.displayName,
        status: descriptor.status,
        metadata: descriptor.metadata ?? {},
        registeredAt: descriptor.registeredAt,
      });

      if (!result.ok) {
        throw new Error(`Failed to register zone: ${result.error.message}`, {
          cause: result.error,
        });
      }

      // Fail closed on malformed control-plane replies. Falling back to
      // the caller's input would fabricate a successful registration
      // from local data and emit zone_registered events the hub never
      // confirmed — a split-brain that is expensive to diagnose.
      if (!isZoneDescriptor(result.value)) {
        throw new Error(
          `federation.zone_register returned a payload that is not a ZoneDescriptor (zoneId=${descriptor.zoneId}); refusing to fabricate a registration from local input`,
        );
      }
      const canonical: ZoneDescriptor = result.value;
      projection.set(canonical.zoneId, canonical);
      notify({ kind: "zone_registered", descriptor: canonical });
      return canonical;
    },

    deregister: async (id: ZoneId) => {
      const result = await transport.call<boolean>("federation.zone_deregister", { zoneId: id });

      if (!result.ok) {
        throw new Error(`Failed to deregister zone: ${result.error.message}`, {
          cause: result.error,
        });
      }

      // Fail closed on schema drift / buggy server responses. Treating a
      // non-boolean payload as success would let a single bad message
      // delete the zone locally while the hub still considers it
      // registered — a split-brain that is expensive to detect.
      if (typeof result.value !== "boolean") {
        throw new Error(
          `federation.zone_deregister returned a non-boolean payload (got ${typeof result.value}); refusing to mutate local registry projection`,
        );
      }
      if (result.value) {
        projection.delete(id);
        notify({ kind: "zone_deregistered", zoneId: id });
      }
      return result.value;
    },

    lookup: async (id: ZoneId) => {
      if (mode === "never") return projection.get(id);

      const result = await transport.call<ZoneDescriptor | null>("federation.zone_lookup", {
        zoneId: id,
      });
      if (!result.ok) {
        if (mode === "auto" && isMethodNotFoundError(result.error.message, result.error.code)) {
          // Hub doesn't implement zone_lookup — pin this registry to
          // projection mode so subsequent reads don't keep paying the
          // failed-RPC cost. Real network errors keep propagating.
          mode = "never";
          return projection.get(id);
        }
        throw new Error(`Failed to lookup zone: ${result.error.message}`, {
          cause: result.error,
        });
      }
      if (result.value === null || result.value === undefined) return undefined;
      if (!isZoneDescriptor(result.value)) {
        throw new Error(
          `federation.zone_lookup returned a payload that is not a ZoneDescriptor; refusing to surface untyped data to callers`,
        );
      }
      return result.value;
    },

    list: async (filter?: ZoneFilter) => {
      const localList = (): readonly ZoneDescriptor[] => {
        const entries = [...projection.values()];
        if (filter === undefined) return entries;
        return entries.filter((d) => {
          if (filter.status !== undefined && d.status !== filter.status) return false;
          if (filter.zoneId !== undefined && d.zoneId !== filter.zoneId) return false;
          return true;
        });
      };

      if (mode === "never") return localList();

      const result = await transport.call<readonly ZoneDescriptor[]>("federation.zone_list", {
        filter: filter ?? null,
      });
      if (!result.ok) {
        if (mode === "auto" && isMethodNotFoundError(result.error.message, result.error.code)) {
          mode = "never";
          return localList();
        }
        throw new Error(`Failed to list zones: ${result.error.message}`, {
          cause: result.error,
        });
      }
      if (!Array.isArray(result.value)) {
        throw new Error(
          `federation.zone_list returned a non-array payload; refusing to surface untyped data to callers`,
        );
      }
      const validated: ZoneDescriptor[] = [];
      for (const entry of result.value) {
        if (!isZoneDescriptor(entry)) {
          throw new Error(
            `federation.zone_list returned an entry that is not a ZoneDescriptor; refusing to surface untyped data to callers`,
          );
        }
        validated.push(entry);
      }
      if (filter === undefined) return validated;
      return validated.filter((d) => {
        if (filter.status !== undefined && d.status !== filter.status) return false;
        if (filter.zoneId !== undefined && d.zoneId !== filter.zoneId) return false;
        return true;
      });
    },

    watch: (listener) => {
      listeners = new Set([...listeners, listener]);
      return () => {
        const next = new Set(listeners);
        next.delete(listener);
        listeners = next;
      };
    },

    [Symbol.asyncDispose]: async () => {
      projection.clear();
      listeners = new Set();
    },
  };
}
