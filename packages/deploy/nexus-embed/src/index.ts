/**
 * @koi/nexus-embed — Auto-start local Nexus server for embed mode.
 *
 * L2 package. Two approaches:
 * 1. Legacy: Spawns `nexus serve` as a detached daemon with PID/health management.
 * 2. Modern: Delegates to `nexus init/up/down` CLI (Docker Compose lifecycle).
 */

export { resolveNexusBinary } from "./binary-resolver.js";
export { ensureNexusRunning } from "./ensure-running.js";
export { pollHealth, probeHealth } from "./health-check.js";
export type { NexusInitOptions, NexusLifecycleOptions, NexusUpResult } from "./nexus-lifecycle.js";
export { nexusDown, nexusInit, nexusUp } from "./nexus-lifecycle.js";
export { stopEmbedNexus } from "./stop.js";
export type { ConnectionState, EmbedConfig, EmbedResult } from "./types.js";
