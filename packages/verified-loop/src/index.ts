/**
 * @koi/verified-loop — VerifiedLoop orchestrator.
 *
 * Shifts control from LLM self-assessment to external objective
 * verification. Each iteration gets a clean context window;
 * the filesystem is long-term memory.
 */

export { createCompositeGate, createFileGate, createTestGate } from "./gates.js";
export { appendLearning, readLearnings } from "./learnings.js";
export { markDone, markSkipped, nextItem, readPRD } from "./prd-store.js";
export type {
  EngineEvent,
  EngineInput,
  GateContext,
  IterationContext,
  IterationRecord,
  KoiError,
  LearningsEntry,
  LearningsFile,
  PRDFile,
  PRDItem,
  Result,
  RunIterationFn,
  VerificationFn,
  VerificationResult,
  VerifiedLoop,
  VerifiedLoopConfig,
  VerifiedLoopResult,
} from "./types.js";
export { createVerifiedLoop } from "./verified-loop.js";
