/**
 * @koi/long-running — Multi-session agent harness (L2).
 *
 * Provides a state manager for agents that operate over hours/days
 * across multiple sessions, tracking progress, bridging context,
 * and checkpointing at meaningful task boundaries.
 */

export { computeCheckpointId, shouldSoftCheckpoint } from "./checkpoint-policy.js";
export { buildInitialPrompt, buildResumeContext } from "./context-bridge.js";
export { createLongRunningHarness } from "./harness.js";
export type {
  LongRunningConfig,
  LongRunningHarness,
  ResumeResult,
  SaveStateCallback,
  SessionResult,
  StartResult,
} from "./types.js";
export { DEFAULT_LONG_RUNNING_CONFIG } from "./types.js";
