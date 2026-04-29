/**
 * @koi/forge-integrity — Content-addressed integrity, minimal provenance,
 * and lineage helpers for forged bricks (L2). Issue #1348.
 */

export type {
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
export { verifyBrickIntegrity } from "./integrity.js";

export type { LineageOutcome } from "./lineage.js";
export {
  findDuplicateById,
  getParentBrickId,
  isDerivedFrom,
  MAX_LINEAGE_DEPTH,
} from "./lineage.js";

export type { CreateProvenanceOptions } from "./provenance.js";
export { createForgeProvenance } from "./provenance.js";
