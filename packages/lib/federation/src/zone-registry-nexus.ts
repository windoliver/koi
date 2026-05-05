/**
 * Nexus-backed ZoneRegistry implementation.
 *
 * Uses NexusTransport JSON-RPC to manage zone lifecycle on a Nexus server.
 * Maintains an in-memory projection for fast reads.
 */

import type { ZoneDescriptor, ZoneEvent, ZoneFilter, ZoneId, ZoneRegistry } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

/** Config for createZoneRegistryNexus. */
export interface ZoneRegistryNexusConfig {
  readonly transport: NexusTransport;
}

/** Type guard — checks the rpc result is a usable ZoneDescriptor. */
function isZoneDescriptor(value: unknown): value is ZoneDescriptor {
  if (value === null || typeof value !== "object") return false;
  if (!("zoneId" in value)) return false;
  const candidate: { readonly zoneId: unknown } = value;
  return typeof candidate.zoneId === "string";
}

/**
 * Creates a ZoneRegistry backed by a Nexus JSON-RPC server.
 *
 * Pattern: follows @koi/permissions-nexus — inject NexusTransport, call transport.call<T>().
 */
export function createZoneRegistryNexus(config: ZoneRegistryNexusConfig): ZoneRegistry {
  const { transport } = config;

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

      // Use server-returned descriptor when shape is valid (allows server-side canonicalization),
      // otherwise fall back to caller's input.
      const canonical: ZoneDescriptor = isZoneDescriptor(result.value) ? result.value : descriptor;
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

      const serverConfirmed = typeof result.value === "boolean" ? result.value : projection.has(id);
      if (serverConfirmed) {
        projection.delete(id);
        notify({ kind: "zone_deregistered", zoneId: id });
      }
      return serverConfirmed;
    },

    lookup: (id: ZoneId) => {
      return projection.get(id);
    },

    list: (filter?: ZoneFilter) => {
      const entries = [...projection.values()];
      if (filter === undefined) return entries;

      return entries.filter((d) => {
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
