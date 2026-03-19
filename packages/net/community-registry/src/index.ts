/**
 * @koi/community-registry — Community registry HTTP server for brick distribution.
 *
 * L3 meta-package. Provides a composable HTTP handler for brick search,
 * retrieval, and publish with optional security gate scanning.
 */

export type { DefaultRegistryConfig } from "./create-default-registry.js";
export { createDefaultRegistry } from "./create-default-registry.js";
export type { CommunityRegistryHandler } from "./handler.js";
export { createCommunityRegistryHandler } from "./handler.js";
export type { SecurityDecision, SecurityVerdict } from "./security-gate.js";
export { evaluateSecurityGate } from "./security-gate.js";
export type {
  AttestationVerifier,
  BatchCheckRequest,
  BatchCheckResponse,
  CommunityRegistryConfig,
  IntegrityCheckResult,
  IntegrityVerifier,
  SecurityGate,
  SecurityGateResult,
} from "./types.js";
