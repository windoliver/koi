/**
 * @koi/long-running — Multi-session agent harness (L2).
 *
 * Provides a state manager for agents that operate over hours/days
 * across multiple sessions, tracking progress, bridging context,
 * and checkpointing at meaningful task boundaries.
 */

export type { AutonomousProviderConfig } from "./autonomous-provider.js";
export { createAutonomousProvider } from "./autonomous-provider.js";
export type { CheckpointMiddlewareConfig } from "./checkpoint-middleware.js";
export { createCheckpointMiddleware } from "./checkpoint-middleware.js";
export { computeCheckpointId, shouldSoftCheckpoint } from "./checkpoint-policy.js";
export { buildInitialPrompt, buildResumeContext } from "./context-bridge.js";
export type { DelegationBridge, DelegationBridgeConfig } from "./delegation-bridge.js";
export { createDelegationBridge } from "./delegation-bridge.js";
export { createLongRunningHarness, mapProcessStateToHarnessPhase } from "./harness.js";
export type { InboxMiddlewareConfig } from "./inbox-middleware.js";
export { createInboxMiddleware } from "./inbox-middleware.js";
export type { PlanAutonomousConfig } from "./plan-autonomous-tool.js";
export { createPlanAutonomousProvider } from "./plan-autonomous-tool.js";
export type { TaskToolsConfig } from "./task-tools.js";
export { createTaskTools } from "./task-tools.js";
export { createThreadCompactor } from "./thread-compactor.js";
export type {
  LongRunningConfig,
  LongRunningHarness,
  OnCompletedCallback,
  OnFailedCallback,
  ResumeResult,
  SaveStateCallback,
  SessionResult,
  StartResult,
} from "./types.js";
export { DEFAULT_LONG_RUNNING_CONFIG } from "./types.js";
