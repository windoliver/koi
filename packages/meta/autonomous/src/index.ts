/**
 * @koi/autonomous — Coordinated autonomous agent composition (L3).
 *
 * Composes long-running harness + scheduler + optional compactor middleware
 * into a single AutonomousAgent with checkpoint/inbox support.
 */
export type { AgentInstantiateConfig, AgentInstantiateResult } from "./agent-instantiate.js";
export { createAgentFromBrick } from "./agent-instantiate.js";
export { createAutonomousAgent } from "./autonomous.js";
export type { SpawnFitnessWrapperConfig, SpawnHealthRecorder } from "./spawn-fitness-wrapper.js";
export { createSpawnFitnessWrapper, embedBrickId } from "./spawn-fitness-wrapper.js";
export type { AutonomousAgent, AutonomousAgentParts } from "./types.js";
