import type { CapabilityId, CapabilityToken } from "@koi/core";

export interface CapabilityRevocationRegistry {
  readonly register: (token: CapabilityToken) => void | Promise<void>;
  readonly isRevoked: (id: CapabilityId) => boolean | Promise<boolean>;
  readonly revoke: (id: CapabilityId, cascade: boolean) => void | Promise<void>;
}

export function createMemoryCapabilityRevocationRegistry(): CapabilityRevocationRegistry {
  const revoked = new Set<CapabilityId>();
  const children = new Map<CapabilityId, Set<CapabilityId>>();

  return {
    register(token: CapabilityToken): void {
      if (token.parentId !== undefined) {
        const set = children.get(token.parentId) ?? new Set<CapabilityId>();
        set.add(token.id);
        children.set(token.parentId, set);
      }
    },
    isRevoked(id: CapabilityId): boolean {
      return revoked.has(id);
    },
    revoke(id: CapabilityId, cascade: boolean): void {
      revoked.add(id);
      if (!cascade) return;
      const queue: CapabilityId[] = [id];
      const seen = new Set<CapabilityId>([id]);
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        const kids = children.get(next);
        if (!kids) continue;
        for (const kid of kids) {
          if (seen.has(kid)) continue;
          seen.add(kid);
          revoked.add(kid);
          queue.push(kid);
        }
      }
    },
  };
}
