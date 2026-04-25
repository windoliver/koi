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

async function signAndRegister(
  unsigned: CapabilityToken,
  signer: CapabilitySigner,
  registry: CapabilityRevocationRegistry | undefined,
): Promise<CapabilityToken> {
  const proof = buildProof(unsigned, signer);
  const signed: CapabilityToken = { ...unsigned, proof };
  if (registry) {
    await registry.register(signed);
  }
  return signed;
}

export async function issueRootCapability(opts: IssueRootOptions): Promise<CapabilityToken> {
  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
    throw new Error("issueRootCapability: ttlMs must be a finite number > 0");
  }
  if (!Number.isFinite(opts.maxChainDepth) || opts.maxChainDepth < 0) {
    throw new Error("issueRootCapability: maxChainDepth must be a finite number >= 0");
  }
  const now = opts.now?.() ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("issueRootCapability: now() must return a finite number");
  }
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
  return signAndRegister(unsigned, opts.signer, opts.registry);
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

/**
 * Resource attenuation. If parent has no resource restriction (undefined or empty),
 * any child resources are accepted. Otherwise the child must declare resources and
 * every entry must appear verbatim in the parent's set.
 */
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

function fail(reason: DelegationFailureReason): KoiError {
  if (reason === "expired") {
    return { ...validation("delegateCapability: parent expired"), context: { reason } };
  }
  return { ...permission(`delegateCapability: ${reason}`), context: { reason } };
}

export async function delegateCapability(
  opts: DelegateOptions,
): Promise<Result<CapabilityToken, KoiError>> {
  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
    throw new Error("delegateCapability: ttlMs must be a finite number > 0");
  }
  const now = opts.now?.() ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("delegateCapability: now() must return a finite number");
  }
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
  if (!isResourceSubset(opts.scope.resources, parent.scope.resources)) {
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
  const signed = await signAndRegister(unsigned, opts.signer, opts.registry);
  return { ok: true, value: signed };
}
