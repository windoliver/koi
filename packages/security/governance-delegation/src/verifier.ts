import type {
  AgentId,
  CapabilityId,
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  ScopeChecker,
  VerifyContext,
} from "@koi/core";
import { isPermissionSubset } from "@koi/core";
import { verifyEd25519 } from "./ed25519.js";
import { verifyHmac } from "./hmac.js";
import type { CapabilityRevocationRegistry, CapabilityTokenStore } from "./revocation.js";

export interface CapabilityVerifierOptions {
  /**
   * HMAC verifier configuration. `rootIssuer` (when set) restricts the
   * AgentId allowed on chainDepth=0 tokens to a single issuer — without it,
   * any holder of the secret can mint root tokens claiming any issuerId.
   */
  readonly hmac?: { readonly secret: Uint8Array; readonly rootIssuer?: AgentId };
  /**
   * Ed25519 verifier configuration. `rootIssuers` (when set) binds each
   * public-key fingerprint to the AgentId it is authorized to sign root
   * tokens for. chainDepth=0 tokens whose proof.publicKey is not in the
   * map, or whose issuerId disagrees with the bound AgentId, are rejected.
   */
  readonly ed25519?: {
    readonly publicKeys: ReadonlyMap<string, Uint8Array>;
    readonly rootIssuers?: ReadonlyMap<string, AgentId>;
  };
  readonly scopeChecker: ScopeChecker;
  readonly revocations?: CapabilityRevocationRegistry;
  /**
   * Token store for chain walking. Required when verifying chainDepth>0
   * tokens — without it the verifier rejects any non-root token because
   * it cannot resolve and validate the parent chain.
   */
  readonly tokenStore?: CapabilityTokenStore;
}

function deny(reason: CapabilityVerifyResult & { readonly ok: false }): CapabilityVerifyResult {
  return reason;
}

function isResourceSubset(
  child: readonly string[] | undefined,
  parent: readonly string[] | undefined,
): boolean {
  if (parent === undefined || parent.length === 0) return true;
  if (child === undefined || child.length === 0) return false;
  const parentSet = new Set(parent);
  for (const entry of child) {
    if (!parentSet.has(entry)) return false;
  }
  return true;
}

async function verifySignature(
  token: CapabilityToken,
  opts: CapabilityVerifierOptions,
): Promise<CapabilityVerifyResult | undefined> {
  if (token.proof.kind === "hmac-sha256") {
    if (!opts.hmac) return deny({ ok: false, reason: "proof_type_unsupported" });
    if (!verifyHmac(token, opts.hmac.secret)) {
      return deny({ ok: false, reason: "invalid_signature" });
    }
    return undefined;
  }
  if (token.proof.kind === "ed25519") {
    if (!opts.ed25519) return deny({ ok: false, reason: "proof_type_unsupported" });
    if (!verifyEd25519(token, opts.ed25519.publicKeys)) {
      return deny({ ok: false, reason: "invalid_signature" });
    }
    return undefined;
  }
  return deny({ ok: false, reason: "proof_type_unsupported" });
}

function verifyRootAuthority(
  token: CapabilityToken,
  opts: CapabilityVerifierOptions,
): CapabilityVerifyResult | undefined {
  // Only enforced for chainDepth=0 tokens (root issuance).
  if (token.proof.kind === "hmac-sha256") {
    const expected = opts.hmac?.rootIssuer;
    if (expected !== undefined && token.issuerId !== expected) {
      return deny({ ok: false, reason: "invalid_signature" });
    }
    return undefined;
  }
  if (token.proof.kind === "ed25519") {
    const map = opts.ed25519?.rootIssuers;
    if (map !== undefined) {
      const bound = map.get(token.proof.publicKey);
      if (bound === undefined || bound !== token.issuerId) {
        return deny({ ok: false, reason: "invalid_signature" });
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * Verify a single token's structural validity (signature, expiry, session,
 * revocation, root-authority binding). Does NOT check scope or chain — those
 * happen in the caller. Used for both leaf and ancestor verification.
 */
async function verifyStructural(
  token: CapabilityToken,
  ctx: VerifyContext,
  opts: CapabilityVerifierOptions,
): Promise<CapabilityVerifyResult | undefined> {
  const sig = await verifySignature(token, opts);
  if (sig) return sig;
  if (ctx.now < token.createdAt) {
    return deny({ ok: false, reason: "invalid_signature" });
  }
  if (ctx.now >= token.expiresAt) {
    return deny({ ok: false, reason: "expired" });
  }
  if (!ctx.activeSessionIds.has(token.scope.sessionId)) {
    return deny({ ok: false, reason: "session_invalid" });
  }
  if (opts.revocations && (await opts.revocations.isRevoked(token.id))) {
    return deny({ ok: false, reason: "revoked" });
  }
  // Root binding only applies to chainDepth=0; non-root tokens carry their
  // authority via the parent chain (verified separately).
  if (token.chainDepth === 0) {
    const root = verifyRootAuthority(token, opts);
    if (root) return root;
  }
  return undefined;
}

/**
 * Walk and validate the parent chain from `child` toward the root.
 * Returns a deny result on any failure, or undefined when the chain is
 * structurally + cryptographically valid and child's scope properly
 * attenuates each ancestor.
 */
async function verifyChain(
  child: CapabilityToken,
  ctx: VerifyContext,
  opts: CapabilityVerifierOptions,
  visited: ReadonlySet<CapabilityId>,
): Promise<CapabilityVerifyResult | undefined> {
  if (child.chainDepth === 0) {
    if (child.parentId !== undefined) {
      // chainDepth=0 with a parentId is an inconsistency — treat as forged.
      return deny({ ok: false, reason: "invalid_signature" });
    }
    return undefined;
  }

  if (child.parentId === undefined) {
    return deny({ ok: false, reason: "invalid_signature" });
  }
  if (!opts.tokenStore) {
    // Without a store we cannot validate the chain. Fail closed.
    return deny({ ok: false, reason: "unknown_grant" });
  }
  if (visited.has(child.parentId)) {
    // Cycle defense.
    return deny({ ok: false, reason: "invalid_signature" });
  }

  const parent = await opts.tokenStore.get(child.parentId);
  if (!parent) {
    return deny({ ok: false, reason: "unknown_grant" });
  }

  // Structural validation of the parent (recursive — re-runs every check).
  const parentStructural = await verifyStructural(parent, ctx, opts);
  if (parentStructural) return parentStructural;

  // Continuity: parent.delegateeId must be the issuer of the child.
  if (parent.delegateeId !== child.issuerId) {
    return deny({ ok: false, reason: "invalid_signature" });
  }
  // Continuity: chainDepth must increment by exactly one.
  if (parent.chainDepth + 1 !== child.chainDepth) {
    return deny({ ok: false, reason: "invalid_signature" });
  }
  // Continuity: child must not outlive parent.
  if (child.expiresAt > parent.expiresAt) {
    return deny({ ok: false, reason: "expired" });
  }
  // Continuity: same session.
  if (parent.scope.sessionId !== child.scope.sessionId) {
    return deny({ ok: false, reason: "session_invalid" });
  }
  // Attenuation: child permissions must be a subset of parent permissions.
  if (!isPermissionSubset(child.scope.permissions, parent.scope.permissions)) {
    return deny({ ok: false, reason: "scope_exceeded" });
  }
  // Attenuation: child resources must be a subset of parent resources (when parent restricts).
  if (!isResourceSubset(child.scope.resources, parent.scope.resources)) {
    return deny({ ok: false, reason: "scope_exceeded" });
  }

  // Recurse: check parent's parent.
  const visitedNext = new Set(visited);
  visitedNext.add(child.parentId);
  return verifyChain(parent, ctx, opts, visitedNext);
}

export function createCapabilityVerifier(opts: CapabilityVerifierOptions): CapabilityVerifier {
  return {
    async verify(token: CapabilityToken, ctx: VerifyContext): Promise<CapabilityVerifyResult> {
      const structural = await verifyStructural(token, ctx, opts);
      if (structural) return structural;

      const chain = await verifyChain(token, ctx, opts, new Set<CapabilityId>([token.id]));
      if (chain) return chain;

      const allowed = await opts.scopeChecker.isAllowed(ctx.toolId, {
        permissions: token.scope.permissions,
        ...(token.scope.resources ? { resources: token.scope.resources } : {}),
        sessionId: token.scope.sessionId,
      });
      if (!allowed) {
        return deny({ ok: false, reason: "scope_exceeded" });
      }
      return { ok: true, token };
    },
  };
}
