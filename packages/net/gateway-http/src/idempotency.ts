import { createLru, type Lru } from "./lru.js";

export interface IdempotencyConfig {
  readonly perTenantCapacity: number;
  readonly maxTenants: number;
  readonly ttlSeconds: number;
}

export interface CachedResponse {
  readonly status: number;
  readonly body: string;
  readonly frameId: string;
}

type Entry =
  | { readonly kind: "pending"; readonly insertedAtMs: number }
  | {
      readonly kind: "completed";
      readonly insertedAtMs: number;
      readonly response: CachedResponse;
    };

export type ReserveResult =
  | { readonly kind: "reserved" }
  | { readonly kind: "in-flight" }
  | { readonly kind: "cached"; readonly response: CachedResponse };

export interface IdempotencyStore {
  readonly reserve: (channelId: string, tenantId: string, deliveryId: string) => ReserveResult;
  readonly complete: (
    channelId: string,
    tenantId: string,
    deliveryId: string,
    response: CachedResponse,
  ) => void;
  readonly clear: (channelId: string, tenantId: string, deliveryId: string) => void;
}

export function createIdempotencyStore(
  config: IdempotencyConfig,
  clock: () => number = Date.now,
): IdempotencyStore {
  const channels = new Map<string, Lru<string, Lru<string, Entry>>>();

  function getSlice(channelId: string, tenantId: string): Lru<string, Entry> {
    let slices = channels.get(channelId);
    if (slices === undefined) {
      slices = createLru<string, Lru<string, Entry>>(config.maxTenants);
      channels.set(channelId, slices);
    }
    let slice = slices.get(tenantId);
    if (slice === undefined) {
      slice = createLru<string, Entry>(config.perTenantCapacity);
      slices.set(tenantId, slice);
    }
    return slice;
  }

  function isExpired(entry: Entry, now: number): boolean {
    return now - entry.insertedAtMs > config.ttlSeconds * 1000;
  }

  return {
    reserve(channelId, tenantId, deliveryId) {
      const slice = getSlice(channelId, tenantId);
      const existing = slice.get(deliveryId);
      const now = clock();
      if (existing !== undefined && !isExpired(existing, now)) {
        if (existing.kind === "completed") return { kind: "cached", response: existing.response };
        return { kind: "in-flight" };
      }
      slice.set(deliveryId, { kind: "pending", insertedAtMs: now });
      return { kind: "reserved" };
    },
    complete(channelId, tenantId, deliveryId, response) {
      const slice = getSlice(channelId, tenantId);
      slice.set(deliveryId, { kind: "completed", insertedAtMs: clock(), response });
    },
    clear(channelId, tenantId, deliveryId) {
      const slice = getSlice(channelId, tenantId);
      slice.delete(deliveryId);
    },
  };
}
