/**
 * Nexus-backed ZoneRegistry implementation.
 *
 * Uses NexusClient JSON-RPC to manage zone lifecycle on a Nexus server.
 * Maintains an in-memory projection for fast reads.
 */

import type { ZoneDescriptor, ZoneEvent, ZoneFilter, ZoneId, ZoneRegistry } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";

/** Config for createZoneRegistryNexus. */
export interface ZoneRegistryNexusConfig {
  readonly client: NexusClient;
}

/**
 * Creates a ZoneRegistry backed by a Nexus JSON-RPC server.
 *
 * Pattern: follows @koi/permissions-nexus — inject NexusClient, call client.rpc<T>().
 */
export function createZoneRegistryNexus(config: ZoneRegistryNexusConfig): ZoneRegistry {
  const { client } = config;

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
      const result = await client.rpc<ZoneDescriptor>("federation.zone_register", {
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

      // Use server-returned descriptor if it includes required fields (may include canonicalization),
      // otherwise fall back to caller's input for backward compatibility.
      const canonical: ZoneDescriptor =
        result.value !== null &&
        typeof result.value === "object" &&
        typeof result.value.zoneId === "string"
          ? result.value
          : descriptor;
      projection.set(canonical.zoneId, canonical);
      notify({ kind: "zone_registered", descriptor: canonical });
      return canonical;
    },

    deregister: async (id: ZoneId) => {
      const result = await client.rpc<boolean>("federation.zone_deregister", {
        zoneId: id,
      });

      if (!result.ok) {
        throw new Error(`Failed to deregister zone: ${result.error.message}`, {
          cause: result.error,
        });
      }

      // Use server's boolean response when available; fall back to local projection
      // for servers that don't return a boolean (e.g., return void/null).
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
