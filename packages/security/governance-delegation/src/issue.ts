import { randomUUID } from "node:crypto";
import type { AgentId, CapabilityScope, CapabilityToken, KoiError, Result } from "@koi/core";
import { capabilityId, isPermissionSubset, permission, validation } from "@koi/core";
import type { CapabilityRevocationRegistry } from "./revocation.js";
import type { CapabilitySigner } from "./signer.js";
import { buildProof } from "./signer.js";

interface IssueRootOptions {
  readonly signer: CapabilitySigner;
  readonly issuerId: AgentId;
  readonly delegateeId: AgentId;
  readonly scope: CapabilityScope;
  readonly ttlMs: number;
  readonly maxChainDepth: number;
  readonly registry?: CapabilityRevocationRegistry;
  readonly now?: () => number;
}

export async function issueRootCapability(opts: IssueRootOptions): Promise<CapabilityToken> {
  if (opts.ttlMs <= 0) throw new Error("issueRootCapability: ttlMs must be > 0");
  if (opts.maxChainDepth < 0) {
    throw new Error("issueRootCapability: maxChainDepth must be >= 0");
  }
  const now = opts.now?.() ?? Date.now();
  const unsigned: CapabilityToken = {
    id: capabilityId(randomUUID()),
    issuerId: opts.issuerId,
    delegateeId: opts.delegateeId,
    scope: opts.scope,
    chainDepth: 0,
    maxChainDepth: opts.maxChainDepth,
    createdAt: now,
    expiresAt: now + opts.ttlMs,
    proof: { kind: "hmac-sha256", digest: "" },
  };
  const proof = buildProof(unsigned, opts.signer);
  const signed: CapabilityToken = { ...unsigned, proof };
  if (opts.registry) {
    await opts.registry.register(signed);
  }
  return signed;
}

interface DelegateOptions {
  readonly signer: CapabilitySigner;
  readonly parent: CapabilityToken;
  readonly delegateeId: AgentId;
  readonly scope: CapabilityScope;
  readonly ttlMs: number;
  readonly registry?: CapabilityRevocationRegistry;
  readonly now?: () => number;
}

type DelegationFailureReason =
  | "expired"
  | "chain_depth_exceeded"
  | "scope_exceeded"
  | "session_mismatch"
  | "ttl_exceeds_parent";

function fail(reason: DelegationFailureReason): KoiError {
  if (reason === "expired") {
    return { ...validation("delegateCapability: parent expired"), context: { reason } };
  }
  return { ...permission(`delegateCapability: ${reason}`), context: { reason } };
}

export async function delegateCapability(
  opts: DelegateOptions,
): Promise<Result<CapabilityToken, KoiError>> {
  if (opts.ttlMs <= 0) throw new Error("delegateCapability: ttlMs must be > 0");
  const now = opts.now?.() ?? Date.now();
  const parent = opts.parent;

  if (parent.expiresAt <= now) {
    return { ok: false, error: fail("expired") };
  }
  if (parent.chainDepth + 1 > parent.maxChainDepth) {
    return { ok: false, error: fail("chain_depth_exceeded") };
  }
  if (parent.scope.sessionId !== opts.scope.sessionId) {
    return { ok: false, error: fail("session_mismatch") };
  }
  if (!isPermissionSubset(opts.scope.permissions, parent.scope.permissions)) {
    return { ok: false, error: fail("scope_exceeded") };
  }
  const childExpires = now + opts.ttlMs;
  if (childExpires > parent.expiresAt) {
    return { ok: false, error: fail("ttl_exceeds_parent") };
  }

  const unsigned: CapabilityToken = {
    id: capabilityId(randomUUID()),
    issuerId: parent.delegateeId,
    delegateeId: opts.delegateeId,
    scope: opts.scope,
    parentId: parent.id,
    chainDepth: parent.chainDepth + 1,
    maxChainDepth: parent.maxChainDepth,
    createdAt: now,
    expiresAt: childExpires,
    proof: { kind: "hmac-sha256", digest: "" },
  };
  const proof = buildProof(unsigned, opts.signer);
  const signed: CapabilityToken = { ...unsigned, proof };
  if (opts.registry) {
    await opts.registry.register(signed);
  }
  return { ok: true, value: signed };
}
