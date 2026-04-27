import type { DelegationId, RevocationRegistry } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusRevocationRegistryConfig {
  readonly transport: NexusTransport;
  readonly policyPath?: string | undefined;
}

const DEFAULT_POLICY_PATH = "koi/permissions";

export function createNexusRevocationRegistry(
  config: NexusRevocationRegistryConfig,
): Required<RevocationRegistry> {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;

  const isRevoked = async (id: DelegationId): Promise<boolean> => {
    const result = await config.transport.call<string>("read", {
      path: `${policyPath}/revocations/${id}.json`,
    });
    if (!result.ok) {
      return result.error.code !== "NOT_FOUND"; // NOT_FOUND = not revoked; else fail-closed
    }
    try {
      const data = JSON.parse(result.value) as { readonly revoked: unknown };
      return data.revoked === true; // strict boolean check — anything else fails closed
    } catch {
      return true; // Malformed = fail-closed
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
      // Cascade requires traversing the delegation chain, which the Nexus registry
      // cannot do without an index. Callers must call revoke() on each descendant
      // individually (DelegationManager handles this at a higher layer).
      throw new Error(
        `NexusRevocationRegistry: cascade=true is not supported. ` +
          `Revoke each descendant explicitly or use an in-memory registry for cascade.`,
      );
    }
    const result = await config.transport.call("write", {
      path: `${policyPath}/revocations/${id}.json`,
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
