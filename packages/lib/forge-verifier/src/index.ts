/**
 * @koi/forge-verifier — sequential, short-circuiting verification pipeline
 * for forge artifacts. L2.
 *
 * Owns: stage sequencing, per-stage timing, result caching, error mapping.
 * Does NOT own: stage logic (callers inject `VerifierStage` values).
 */

export { createMemoryCache } from "./cache.js";
export { runPipeline } from "./pipeline.js";
export { createSyntaxStage, createTestStage, createTypeStage } from "./stages.js";
export type {
  ArtifactFingerprintFn,
  StageContext,
  StageOutcome,
  VerificationCache,
  VerifierStage,
  VerifyOptions,
} from "./types.js";
