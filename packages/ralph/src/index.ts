/**
 * @koi/ralph — Ralph Loop orchestrator.
 *
 * Shifts control from LLM self-assessment to external objective
 * verification. Each iteration gets a clean context window;
 * the filesystem is long-term memory.
 */

export { createCompositeGate, createFileGate, createTestGate } from "./gates.js";
export { appendLearning, readLearnings } from "./learnings.js";
export { markDone, markSkipped, nextItem, readPRD } from "./prd-store.js";
export { createRalphLoop } from "./ralph-loop.js";
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
  RalphConfig,
  RalphLoop,
  RalphResult,
  Result,
  RunIterationFn,
  VerificationFn,
  VerificationResult,
} from "./types.js";
