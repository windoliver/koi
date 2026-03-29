/**
 * @koi/autonomous — Coordinated autonomous agent composition (L3).
 *
 * Composes long-running harness + scheduler + optional compactor middleware
 * into a single AutonomousAgent with checkpoint/inbox support.
 */
export type { AgentInstantiateConfig, AgentInstantiateResult } from "./agent-instantiate.js";
export { createAgentFromBrick } from "./agent-instantiate.js";
export { createAutonomousAgent } from "./autonomous.js";
export type {
  CompletionNotifierCallbacks,
  CompletionNotifierConfig,
} from "./completion-notifier.js";
export { createCompletionNotifier } from "./completion-notifier.js";
export type { ReconcileResult } from "./reconciler.js";
export { reconcileTaskBoard } from "./reconciler.js";
export type { RetrySendConfig } from "./retry-send.js";
export { sendWithRetry } from "./retry-send.js";
export type { SpawnFitnessWrapperConfig, SpawnHealthRecorder } from "./spawn-fitness-wrapper.js";
export { createSpawnFitnessWrapper, embedBrickId } from "./spawn-fitness-wrapper.js";
export type { AutonomousAgent, AutonomousAgentParts, AutonomousLogger } from "./types.js";
export { createStderrLogger } from "./types.js";
