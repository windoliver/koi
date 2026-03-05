/**
 * @koi/agent-spawner — Spawn coding agents inside sandboxed containers (L3)
 *
 * Provides ACP (JSON-RPC) and stdio communication paths for delegating
 * coding tasks to external agents in isolation.
 */

// Companion skill
export {
  AGENT_SPAWNER_SKILL,
  createAgentSpawnerSkillProvider,
} from "./companion-skill.js";
// Delegation protocol (exported for testing and advanced usage)
export {
  buildAcpArgs,
  buildAcpStdin,
  buildStdioArgs,
  DEFAULT_TIMEOUT_MS,
  extractAcpOutput,
  parseStdioOutput,
} from "./delegation-protocol.js";
export type { Semaphore } from "./semaphore.js";

// Semaphore (exported for testing)
export { createSemaphore } from "./semaphore.js";
// Spawner factory
export { createAgentSpawner } from "./spawner.js";
// Types
export type {
  AgentSpawner,
  AgentSpawnerConfig,
  DelegationFailureKind,
  SpawnOptions,
} from "./types.js";
