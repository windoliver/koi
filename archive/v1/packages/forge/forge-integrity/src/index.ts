/**
 * @koi/forge-integrity — Attestation, integrity verification, and SLSA serialization.
 *
 * L2 package: depends on @koi/core, @koi/forge-types, and @koi/hash only.
 */

// attestation — provenance creation, signing, verification
export type { CreateProvenanceOptions } from "./attestation.js";
export {
  canonicalJsonSerialize,
  createForgeProvenance,
  signAttestation,
  verifyAttestation,
} from "./attestation.js";
// attestation cache — LRU verification cache
export type { AttestationCache } from "./attestation-cache.js";
export { createAttestationCache } from "./attestation-cache.js";
// brick content — content extraction for hashing
export { extractBrickContent } from "./brick-content.js";
// brick signing — Ed25519 signature creation and verification for trust tiers
export type {
  BrickIdentityPayload,
  BrickSigningError,
  BrickVerificationResult,
  Ed25519KeyPair,
} from "./brick-signing.js";
export {
  classifyTrustTier,
  computeSigningPayload,
  generateBrickSigningKeyPair,
  signBrick,
  verifyBrickSignature,
} from "./brick-signing.js";

// integrity — content-addressed verification
export type {
  IntegrityAttestationFailed,
  IntegrityContentMismatch,
  IntegrityOk,
  IntegrityResult,
} from "./integrity.js";
export { loadAndVerify, verifyBrickAttestation, verifyBrickIntegrity } from "./integrity.js";

// SLSA serializer — SLSA v1.0 predicate mapping
export type {
  SlsaBuildDefinition,
  SlsaBuilder,
  SlsaBuildMetadata,
  SlsaKoiExtensions,
  SlsaProvenanceV1,
  SlsaProvenanceV1WithExtensions,
  SlsaResourceDescriptor,
  SlsaRunDetails,
} from "./slsa-serializer.js";
export { mapProvenanceToSlsa, mapProvenanceToStatement } from "./slsa-serializer.js";
