/**
 * In-memory multi-zone test harness for federation scenarios.
 *
 * Shared backing store per zone — deterministic, no timers, no network.
 */

import { zoneId } from "@koi/core";
import type { SyncClient } from "../sync-protocol.js";
import type { FederationSyncEvent, SyncCursor } from "../types.js";

// ---------------------------------------------------------------------------
// Harness types
// ---------------------------------------------------------------------------

/** A multi-zone test harness with shared in-memory event stores. */
export interface MultiZoneHarness {
  /** Get the SyncClient for a given zone. */
  readonly getClient: (forZone: string) => SyncClient;
  /** Get a mutable reference to a zone's event store (for test setup). */
  readonly getStore: (zone: string) => FederationSyncEvent[];
  /** Publish an event to a zone's store (convenience). */
  readonly publish: (zone: string, event: FederationSyncEvent) => void;
  /** Get all zone IDs. */
  readonly zoneIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a multi-zone test harness.
 *
 * Each zone has its own event store. SyncClients read from the target zone's
 * store, filtering by cursor position.
 */
export function createMultiZoneHarness(zones: readonly string[]): MultiZoneHarness {
  // Shared backing stores: zoneId → events
  const stores = new Map<string, FederationSyncEvent[]>();

  for (const zone of zones) {
    stores.set(zone, []);
  }

  function getStore(zone: string): FederationSyncEvent[] {
    const store = stores.get(zone);
    if (store === undefined) {
      const newStore: FederationSyncEvent[] = [];
      stores.set(zone, newStore);
      return newStore;
    }
    return store;
  }

  return {
    getClient: (_forZone) => ({
      fetchDelta: async (cursor) => {
        const store = getStore(cursor.zoneId);
        const newEvents = store.filter((e) => e.sequence > cursor.lastSequence);
        return { ok: true as const, value: newEvents };
      },
      publishEvents: async (events) => {
        for (const event of events) {
          const store = getStore(event.originZoneId);
          store.push(event);
        }
        return { ok: true as const, value: undefined };
      },
    }),

    getStore,

    publish: (zone, event) => {
      const store = getStore(zone);
      store.push(event);
    },

    zoneIds: zones,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a test sync event. */
export function createTestEvent(
  zone: string,
  sequence: number,
  emittedAt?: number,
): FederationSyncEvent {
  return {
    kind: "test_event",
    originZoneId: zoneId(zone),
    sequence,
    vectorClock: { [zone]: sequence },
    data: { seq: sequence },
    emittedAt: emittedAt ?? Date.now(),
  };
}

/** Create an initial cursor for a zone. */
export function createInitialCursor(zone: string): SyncCursor {
  return {
    zoneId: zoneId(zone),
    vectorClock: {},
    lastSequence: 0,
    lastSyncAt: 0,
  };
}
