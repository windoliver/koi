/**
 * Maps a DelegationGrant to a CapabilityToken for verification.
 *
 * Returns undefined if the grant has no sessionId (not session-scoped).
 * When a sessionId is present, the grant is mapped to a CapabilityToken
 * with branded IDs for compile-time safety.
 *
 * Crypto-safe: branded types (capabilityId, sessionId) are compile-time
 * TypeScript metadata. At runtime, the values are identical strings.
 * canonicalize() serializes runtime values → identical canonical JSON →
 * signature verification passes.
 */

import type { CapabilityToken, DelegationGrant } from "@koi/core";
import { capabilityId, sessionId } from "@koi/core";

export function mapGrantToCapabilityToken(grant: DelegationGrant): CapabilityToken | undefined {
  if (grant.scope.sessionId === undefined) return undefined;

  return {
    id: capabilityId(grant.id),
    issuerId: grant.issuerId,
    delegateeId: grant.delegateeId,
    scope: {
      permissions: grant.scope.permissions,
      ...(grant.scope.resources !== undefined ? { resources: grant.scope.resources } : {}),
      sessionId: sessionId(grant.scope.sessionId),
    },
    ...(grant.parentId !== undefined ? { parentId: capabilityId(grant.parentId) } : {}),
    chainDepth: grant.chainDepth,
    maxChainDepth: grant.maxChainDepth,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    proof: grant.proof,
  };
}
