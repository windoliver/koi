/**
 * Nexus-backed ZoneRegistry implementation.
 *
 * Uses NexusTransport JSON-RPC to manage zone lifecycle on a Nexus server.
 * Reads (`lookup`, `list`) default to writer-local projection — Phase 3
 * hubs do not implement `zone_lookup` / `zone_list` RPCs, so unconditional
 * server reads would be a control-plane outage. Operators can opt into
 * authoritative server reads via `useServerReads: true` once their hub
 * advertises the read handlers. Cross-process discovery against pre-v1
 * hubs and capability negotiation are tracked in #1410.
 */

import type { ZoneDescriptor, ZoneEvent, ZoneFilter, ZoneId, ZoneRegistry } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

/** Config for createZoneRegistryNexus. */
export interface ZoneRegistryNexusConfig {
  readonly transport: NexusTransport;
  /**
   * When `true`, `lookup()` and `list()` query the hub via
   * `federation.zone_lookup` / `federation.zone_list` so processes
   * that did not personally call `register()` can still discover peers.
   *
   * Defaults to `false` for wire compatibility: Phase 3 hubs only
   * advertise `federation.zone_register` / `federation.zone_deregister`,
   * and unconditionally issuing the read RPCs would turn discovery into
   * a control-plane outage against unupgraded hubs. Operators must
   * explicitly opt in once their hub implements the read handlers.
   * In the default mode, reads come from the local projection — the
   * same writer-only behavior the v1 baseline shipped with.
   */
  readonly useServerReads?: boolean;
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
  const useServerReads = config.useServerReads ?? false;

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
      if (!useServerReads) {
        return projection.get(id);
      }
      const result = await transport.call<ZoneDescriptor | null>("federation.zone_lookup", {
        zoneId: id,
      });
      if (!result.ok) {
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
      if (!useServerReads) {
        const entries = [...projection.values()];
        if (filter === undefined) return entries;
        return entries.filter((d) => {
          if (filter.status !== undefined && d.status !== filter.status) return false;
          if (filter.zoneId !== undefined && d.zoneId !== filter.zoneId) return false;
          return true;
        });
      }
      const result = await transport.call<readonly ZoneDescriptor[]>("federation.zone_list", {
        filter: filter ?? null,
      });
      if (!result.ok) {
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
