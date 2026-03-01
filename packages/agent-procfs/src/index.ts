/**
 * @koi/agent-procfs — Agent introspection via virtual filesystem (Layer 2)
 *
 * Provides a ProcFs implementation with TTL microcache and an agent mounter
 * that watches the registry to mount/unmount per-agent entries.
 *
 * Depends only on @koi/core (L0).
 */

export type { AgentMounter, AgentMounterConfig, AgentProvider } from "./agent-mounter.js";
export { createAgentMounter } from "./agent-mounter.js";
export type { ProcFsConfig } from "./procfs-impl.js";
export { createProcFs } from "./procfs-impl.js";
