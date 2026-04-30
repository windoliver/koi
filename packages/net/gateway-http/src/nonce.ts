import { createLru, type Lru } from "./lru.js";

export interface NonceStoreConfig {
  readonly perTenantCapacity: number;
  readonly maxTenants: number;
}

export interface NonceStore {
  /** Returns true if the nonce was new (and is now stored), false if already seen. */
  readonly checkAndInsert: (channelId: string, tenantId: string, nonce: string) => boolean;
  readonly tenantCount: (channelId: string) => number;
}

export function createNonceStore(config: NonceStoreConfig): NonceStore {
  const channels = new Map<string, Lru<string, Lru<string, true>>>();

  function getTenantSlices(channelId: string): Lru<string, Lru<string, true>> {
    let slices = channels.get(channelId);
    if (slices === undefined) {
      slices = createLru<string, Lru<string, true>>(config.maxTenants);
      channels.set(channelId, slices);
    }
    return slices;
  }

  return {
    checkAndInsert(channelId, tenantId, nonce) {
      const slices = getTenantSlices(channelId);
      let nonces = slices.get(tenantId);
      if (nonces === undefined) {
        nonces = createLru<string, true>(config.perTenantCapacity);
        slices.set(tenantId, nonces);
      }
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, true);
      return true;
    },
    tenantCount(channelId) {
      return channels.get(channelId)?.size() ?? 0;
    },
  };
}
