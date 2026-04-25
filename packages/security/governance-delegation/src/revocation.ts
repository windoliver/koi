import type { CapabilityId, CapabilityToken } from "@koi/core";

export interface CapabilityRevocationRegistry {
  readonly register: (token: CapabilityToken) => void | Promise<void>;
  readonly isRevoked: (id: CapabilityId) => boolean | Promise<boolean>;
  readonly revoke: (id: CapabilityId, cascade: boolean) => void | Promise<void>;
}

/**
 * Pluggable token lookup. Verifier uses this to walk the parent chain when
 * checking chainDepth>0 tokens. Returns undefined when the parent is unknown
 * (caller treats as `unknown_grant`).
 */
export interface CapabilityTokenStore {
  readonly get: (
    id: CapabilityId,
  ) => CapabilityToken | undefined | Promise<CapabilityToken | undefined>;
}

/**
 * In-memory implementation that satisfies both `CapabilityRevocationRegistry`
 * and `CapabilityTokenStore` so the verifier can walk the chain through the
 * same instance that tracks revocations.
 */
export function createMemoryCapabilityRevocationRegistry(): CapabilityRevocationRegistry &
  CapabilityTokenStore {
  const revoked = new Set<CapabilityId>();
  const children = new Map<CapabilityId, Set<CapabilityId>>();
  const parents = new Map<CapabilityId, CapabilityId>();
  const tokens = new Map<CapabilityId, CapabilityToken>();

  function isAnyAncestorRevoked(start: CapabilityId): boolean {
    let cursor: CapabilityId | undefined = start;
    const seen = new Set<CapabilityId>();
    while (cursor !== undefined) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      if (revoked.has(cursor)) return true;
      cursor = parents.get(cursor);
    }
    return false;
  }

  return {
    register(token: CapabilityToken): void {
      tokens.set(token.id, token);
      if (token.parentId !== undefined) {
        const set = children.get(token.parentId) ?? new Set<CapabilityId>();
        set.add(token.id);
        children.set(token.parentId, set);
        parents.set(token.id, token.parentId);
        if (isAnyAncestorRevoked(token.parentId)) {
          revoked.add(token.id);
        }
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
    get(id: CapabilityId): CapabilityToken | undefined {
      return tokens.get(id);
    },
  };
}
