// L0 type re-exports (consumer convenience — same identities as @koi/core)
export type {
  AgentId,
  CapabilityId,
  CapabilityProof,
  CapabilityScope,
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  PermissionConfig,
  ScopeChecker,
  SessionId,
  VerifyContext,
} from "@koi/core";
// Issuance
export { delegateCapability, issueRootCapability } from "./issue.js";
// New L2 contracts
export type {
  CapabilityRevocationRegistry,
  CapabilityTokenStore,
} from "./revocation.js";
export { createMemoryCapabilityRevocationRegistry } from "./revocation.js";
// Default scope checker
export { createGlobScopeChecker } from "./scope-checker.js";
// Signer
export type { CapabilitySigner } from "./signer.js";
// Composite verifier
export type { CapabilityVerifierOptions } from "./verifier.js";
export { createCapabilityVerifier } from "./verifier.js";
