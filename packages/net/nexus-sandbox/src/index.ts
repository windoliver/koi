/**
 * @koi/nexus-sandbox — Local nexus-ai-fs[sandbox] subprocess.
 *
 * L2 package. Spawns `nexus serve` with `NEXUS_PROFILE=sandbox`,
 * polls /health, returns a typed handle. Zero Docker, zero external
 * services. For local dev only — production uses external Nexus.
 */

export { resolveCommand } from "./binary-resolver.js";
export type { SpawnFailureContext } from "./errors.js";
export {
  healthTimeoutError,
  portInUseError,
  shutdownTimeoutError,
  spawnFailedError,
} from "./errors.js";
export { pollHealth, probeHealth } from "./health-check.js";
export { startSandbox, stopSandbox } from "./lifecycle.js";
export type {
  FetchFn,
  ResolveCommandOptions,
  SandboxConfig,
  SandboxHandle,
  SpawnedProcess,
  SpawnFn,
  SpawnOptions,
  StopOptions,
} from "./types.js";
