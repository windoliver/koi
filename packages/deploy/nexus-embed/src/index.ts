/**
 * @koi/nexus-embed — Auto-start local Nexus server for embed mode.
 *
 * L2 package. Spawns `nexus serve` as a detached daemon, manages PID files,
 * health-checks with exponential backoff, and provides clean shutdown.
 */

export { resolveNexusBinary } from "./binary-resolver.js";
export { ensureNexusRunning } from "./ensure-running.js";
export { pollHealth, probeHealth } from "./health-check.js";
export { stopEmbedNexus } from "./stop.js";
export type { ConnectionState, EmbedConfig, EmbedResult } from "./types.js";
