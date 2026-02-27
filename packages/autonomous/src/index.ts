/**
 * @koi/autonomous — Coordinated autonomous agent composition (L3).
 *
 * Composes long-running harness + scheduler + optional compactor middleware
 * into a single AutonomousAgent with correct disposal ordering.
 */
export { createAutonomousAgent } from "./autonomous.js";
export type { AutonomousAgent, AutonomousAgentParts } from "./types.js";
