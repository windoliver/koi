/**
 * Grant creation and monotonic attenuation for delegation tokens.
 *
 * Core invariant: child scope <= parent scope. Scopes can only narrow,
 * never widen. Deny rules can only grow (monotonic).
 */

import { randomUUID } from "node:crypto";
import type {
  AgentId,
  DelegationGrant,
  DelegationId,
  DelegationScope,
  KoiError,
  PermissionConfig,
  Result,
} from "@koi/core";
import { signGrant } from "./sign.js";

// ---------------------------------------------------------------------------
// Public param types
// ---------------------------------------------------------------------------

export interface CreateGrantParams {
  readonly issuerId: AgentId;
  readonly delegateeId: AgentId;
  readonly scope: DelegationScope;
  readonly maxChainDepth: number;
  readonly ttlMs: number;
  readonly secret: string;
}

export interface AttenuateParams {
  readonly delegateeId: AgentId;
  readonly scope: DelegationScope;
  readonly ttlMs?: number;
}

// ---------------------------------------------------------------------------
// createGrant
// ---------------------------------------------------------------------------

/** Creates a root delegation grant (chainDepth=0) with HMAC signature. */
export function createGrant(params: CreateGrantParams): Result<DelegationGrant, KoiError> {
  if (params.issuerId.length === 0 || params.delegateeId.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "createGrant: issuerId and delegateeId must be non-empty",
        retryable: false,
        context: { issuerId: params.issuerId, delegateeId: params.delegateeId },
      },
    };
  }
  if (params.ttlMs <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "createGrant: ttlMs must be positive",
        retryable: false,
        context: { ttlMs: params.ttlMs },
      },
    };
  }
  if (params.maxChainDepth < 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "createGrant: maxChainDepth must be >= 0",
        retryable: false,
        context: { maxChainDepth: params.maxChainDepth },
      },
    };
  }

  const now = Date.now();
  const unsigned = {
    id: randomUUID() as DelegationId,
    issuerId: params.issuerId,
    delegateeId: params.delegateeId,
    scope: params.scope,
    chainDepth: 0,
    maxChainDepth: params.maxChainDepth,
    createdAt: now,
    expiresAt: now + params.ttlMs,
  };
  const proof = signGrant(unsigned, params.secret);
  return { ok: true, value: { ...unsigned, proof } };
}

// ---------------------------------------------------------------------------
// attenuateGrant
// ---------------------------------------------------------------------------

/**
 * Creates a child grant from a parent, enforcing monotonic attenuation:
 * - Child allow must be a subset of parent allow
 * - Child must include all parent deny rules
 * - Child expiresAt <= parent expiresAt
 * - Child chainDepth = parent.chainDepth + 1 <= parent.maxChainDepth
 *
 * The parent's delegateeId becomes the child's issuerId (re-delegation).
 */
export function attenuateGrant(
  parent: DelegationGrant,
  params: AttenuateParams,
  secret: string,
): Result<DelegationGrant, KoiError> {
  // Check chain depth
  const nextDepth = parent.chainDepth + 1;
  if (nextDepth > parent.maxChainDepth) {
    return {
      ok: false,
      error: {
        code: "PERMISSION",
        message: `Delegation chain depth ${String(nextDepth)} exceeds max chain depth ${String(parent.maxChainDepth)}`,
        retryable: false,
        context: { chainDepth: nextDepth, maxChainDepth: parent.maxChainDepth },
      },
    };
  }

  // Validate scope attenuation
  const scopeError = validateScopeAttenuation(parent.scope, params.scope);
  if (scopeError !== undefined) {
    return { ok: false, error: scopeError };
  }

  // Compute expiry
  const now = Date.now();
  const childExpiresAt = params.ttlMs !== undefined ? now + params.ttlMs : parent.expiresAt;

  if (childExpiresAt > parent.expiresAt) {
    return {
      ok: false,
      error: {
        code: "PERMISSION",
        message: "Child grant expiry exceeds parent grant expiry",
        retryable: false,
      },
    };
  }

  const unsigned = {
    id: randomUUID() as DelegationId,
    issuerId: parent.delegateeId,
    delegateeId: params.delegateeId,
    scope: params.scope,
    parentId: parent.id,
    chainDepth: nextDepth,
    maxChainDepth: parent.maxChainDepth,
    createdAt: now,
    expiresAt: childExpiresAt,
  };

  const proof = signGrant(unsigned, secret);
  return { ok: true, value: { ...unsigned, proof } };
}

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

function validateScopeAttenuation(
  parent: DelegationScope,
  child: DelegationScope,
): KoiError | undefined {
  // Check permissions subset
  if (!isSubsetPermissions(child.permissions, parent.permissions)) {
    return {
      code: "PERMISSION",
      message:
        "Child scope permissions exceed parent scope — allow must be a subset and all parent deny rules must be preserved",
      retryable: false,
    };
  }

  return undefined;
}

/**
 * Checks if child permissions are a subset of parent permissions:
 * - If parent.allow includes "*", any child allow list is a subset
 * - Otherwise, every allow in child must be present in parent.allow
 * - Every deny in parent must be present in child.deny (deny can only grow)
 */
function isSubsetPermissions(child: PermissionConfig, parent: PermissionConfig): boolean {
  const parentAllow = new Set(parent.allow ?? []);
  const childAllow = child.allow ?? [];

  // Wildcard in parent allows any child allow list
  if (!parentAllow.has("*")) {
    for (const perm of childAllow) {
      if (!parentAllow.has(perm)) {
        return false;
      }
    }
  }

  // Every parent deny must exist in child deny (deny only grows)
  const parentDeny = parent.deny ?? [];
  const childDeny = new Set(child.deny ?? []);

  for (const perm of parentDeny) {
    if (!childDeny.has(perm)) {
      return false;
    }
  }

  return true;
}
