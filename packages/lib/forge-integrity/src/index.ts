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

export type { ProvenanceEquivalent } from "./lineage.js";
// Both lineage helpers (`isDerivedFrom`, `isDerivedFromUnchecked`) are
// intentionally NOT exported in this release. The trusted variant
// requires a producer that hashes `parentBrickId`/`evolutionKind` into
// its canonical id (no shipped producer does yet); the unchecked variant
// would otherwise be the only lineage API and is unsafe on
// attacker-controlled or stale stores. Both will land together in the
// follow-up that extends `@koi/forge-tools` to cover lineage fields. The
// `getParentBrickId` accessor is exported so callers can implement
// narrow, non-policy-bearing inspections without a walk.
export { findContentEquivalentById, getParentBrickId } from "./lineage.js";

export type { CreateProvenanceOptions } from "./provenance.js";
export { createForgeProvenance, MAX_PROVENANCE_DEPTH } from "./provenance.js";
