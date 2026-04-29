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

export type { LineageOutcome, ProvenanceEquivalent } from "./lineage.js";
// `isDerivedFrom` (the trusted lineage API requiring a lineage-bound
// producer) is intentionally NOT exported in this release. No shipped
// producer currently binds lineage fields into its canonical id, so the
// trusted helper would fail closed for every real call. It will be
// exposed in a follow-up release alongside the producer change that
// extends the canonical recompute to cover `parentBrickId`/
// `evolutionKind`. Use `isDerivedFromUnchecked` only for diagnostics
// where the result is explicitly untrusted.
export {
  findContentEquivalentById,
  getParentBrickId,
  isDerivedFromUnchecked,
  MAX_LINEAGE_DEPTH,
} from "./lineage.js";

export type { CreateProvenanceOptions } from "./provenance.js";
export { createForgeProvenance, MAX_PROVENANCE_DEPTH } from "./provenance.js";
