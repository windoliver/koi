/**
 * @koi/agent-spawner — Spawn coding agents inside sandboxed containers (L2)
 *
 * Provides ACP (JSON-RPC) and stdio communication paths for delegating
 * coding tasks to external agents in isolation.
 */

// Adapter → SpawnFn wrapper
export { createAdapterSpawnFn } from "./adapter-spawn.js";
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
// Routing SpawnFn — manifest.sandbox-based dispatch
export type { RoutingSpawnConfig } from "./routing-spawn.js";
export {
  createRoutingSpawnFn,
  mapManifestToDescriptor,
  mapSandboxConfigToProfile,
  validateManifestAgents,
} from "./routing-spawn.js";
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
