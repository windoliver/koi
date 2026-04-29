/**
 * @koi/forge-integrity — Content-addressed integrity, minimal provenance,
 * and lineage helpers for forged bricks (L2). Issue #1348.
 */

export type { BrickContent } from "./extract-content.js";
export { extractBrickContent } from "./extract-content.js";

export type {
  IntegrityContentMismatch,
  IntegrityOk,
  IntegrityResult,
} from "./integrity.js";
export { verifyBrickIntegrity } from "./integrity.js";
export {
  findDuplicateById,
  getParentBrickId,
  isDerivedFrom,
  MAX_LINEAGE_DEPTH,
} from "./lineage.js";
export type { CreateProvenanceOptions } from "./provenance.js";
export { createForgeProvenance } from "./provenance.js";
