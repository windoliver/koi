import { randomUUID } from "node:crypto";
import type { AgentId, CapabilityScope, CapabilityToken } from "@koi/core";
import { capabilityId } from "@koi/core";
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
