/**
 * @koi/forge-integrity — Content-addressed integrity, minimal provenance,
 * and lineage helpers for forged bricks (L2). Issue #1348.
 */

export type {
  BrickVerifier,
  IntegrityContentMismatch,
  IntegrityMalformed,
  IntegrityOk,
  IntegrityProducerMismatch,
  IntegrityProducerUnknown,
  IntegrityRecomputeFailed,
  IntegrityResult,
  ProducerRegistry,
  RecomputeBrickId,
} from "./integrity.js";
// Only the factory entry point is part of the public surface. The raw
// per-call `verifyBrickIntegrity` is intentionally NOT exported: callers
// must bind a trusted registry once at startup via `createBrickVerifier`,
// preventing request-scoped or attacker-controlled registries from being
// passed into the verifier on each call.
export { createBrickVerifier } from "./integrity.js";

export type { IsDerivedFromOptions, LineageOutcome } from "./lineage.js";
export {
  findDuplicateById,
  getParentBrickId,
  isDerivedFrom,
  isDerivedFromUnchecked,
  MAX_LINEAGE_DEPTH,
} from "./lineage.js";

export type { CreateProvenanceOptions } from "./provenance.js";
export { createForgeProvenance, MAX_PROVENANCE_DEPTH } from "./provenance.js";
