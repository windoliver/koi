/**
 * Nexus revocation registry — thin client that delegates all revocation
 * checks to the Nexus server.
 *
 * Fail-closed: any error → treat as revoked.
 */

import type { DelegationId, KoiError, Result, RevocationRegistry } from "@koi/core";
import { delegationId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import type { NexusRevocationBatchResponse, NexusRevocationCheckResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusRevocationRegistryConfig {
  readonly client: NexusClient;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusRevocationRegistry(
  config: NexusRevocationRegistryConfig,
): Required<RevocationRegistry> {
  const isRevoked = async (id: DelegationId): Promise<boolean> => {
    const result: Result<NexusRevocationCheckResponse, KoiError> =
      await config.client.rpc<NexusRevocationCheckResponse>("revocations.check", { id });

    if (!result.ok) return true; // Fail-closed
    return result.value.revoked;
  };

  const isRevokedBatch = async (
    ids: readonly DelegationId[],
  ): Promise<ReadonlyMap<DelegationId, boolean>> => {
    const result: Result<NexusRevocationBatchResponse, KoiError> =
      await config.client.rpc<NexusRevocationBatchResponse>("revocations.checkBatch", {
        ids,
      });

    const resultMap = new Map<DelegationId, boolean>();

    if (!result.ok) {
      // Fail-closed: all revoked
      for (const id of ids) {
        resultMap.set(id, true);
      }
      return resultMap;
    }

    const results = result.value.results;
    if (Array.isArray(results)) {
      for (const entry of results) {
        const entryObj = entry as { readonly id: string; readonly revoked: boolean };
        resultMap.set(delegationId(entryObj.id), entryObj.revoked);
      }
    }

    return resultMap;
  };

  const revoke = async (id: DelegationId, cascade: boolean): Promise<void> => {
    await config.client.rpc<void>("revocations.revoke", { id, cascade });
  };

  return { isRevoked, isRevokedBatch, revoke };
}
