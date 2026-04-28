import type { DelegationId, RevocationRegistry } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusRevocationRegistryConfig {
  readonly transport: NexusTransport;
  readonly policyPath?: string | undefined;
}

const DEFAULT_POLICY_PATH = "koi/permissions";

function validateDelegationIdPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`DelegationId contains unsafe path characters: ${id}`);
  }
  return id;
}

export function createNexusRevocationRegistry(
  config: NexusRevocationRegistryConfig,
): Required<RevocationRegistry> {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;

  const isRevoked = async (id: DelegationId): Promise<boolean> => {
    const safePath = validateDelegationIdPath(id);
    const result = await config.transport.call<string>("read", {
      path: `${policyPath}/revocations/${safePath}.json`,
    });
    if (!result.ok) {
      return result.error.code !== "NOT_FOUND"; // NOT_FOUND = not revoked; else fail-closed
    }
    try {
      const data = JSON.parse(result.value) as { readonly revoked: unknown };
      // Only return false for an explicitly validated not-revoked tombstone.
      // Schema drift, string coercions, missing fields → fail closed (return true = revoked).
      if (data.revoked === false) return false;
      return true;
    } catch {
      return true; // Malformed JSON = fail-closed
    }
  };

  const isRevokedBatch = async (
    ids: readonly DelegationId[],
  ): Promise<ReadonlyMap<DelegationId, boolean>> => {
    const results = await Promise.allSettled(ids.map((id) => isRevoked(id)));
    const map = new Map<DelegationId, boolean>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const r = results[i];
      if (id === undefined || r === undefined) continue;
      map.set(id, r.status === "rejected" ? true : r.value);
    }
    return map;
  };

  const revoke = async (id: DelegationId, cascade: boolean): Promise<void> => {
    if (cascade) {
      // cascade=true has all-or-nothing semantics (target + all descendants).
      // Throw before any side effects to avoid partial state where target is revoked
      // but descendants remain active. Callers must revoke each descendant individually.
      throw new Error(
        `NexusRevocationRegistry: cascade=true is not supported. ` +
          `Revoke each descendant explicitly or use an in-memory registry for cascade.`,
      );
    }
    const safePath = validateDelegationIdPath(id);
    const result = await config.transport.call("write", {
      path: `${policyPath}/revocations/${safePath}.json`,
      content: JSON.stringify({ revoked: true }),
    });
    if (!result.ok) {
      throw new Error(`Failed to persist revocation for grant ${id}: ${result.error.message}`, {
        cause: result.error,
      });
    }
  };

  return { isRevoked, isRevokedBatch, revoke };
}
