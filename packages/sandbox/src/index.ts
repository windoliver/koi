/**
 * @koi/sandbox — OS-level agent sandboxing (Layer 2)
 *
 * Provides macOS Seatbelt and Linux bubblewrap isolation for untrusted code.
 * Depends only on @koi/core (L0). Never imports from @koi/engine or peer L2.
 */

export { createOsAdapter } from "./adapter.js";
export type { SandboxCommand } from "./command.js";
export { buildSandboxCommand } from "./command.js";
export type { PlatformInfo } from "./detect.js";
export { checkAvailability } from "./detect.js";
export type { ExecuteOptions } from "./execute.js";
export { execute } from "./execute.js";
export { permissiveProfile, profileForTier, restrictiveProfile } from "./profiles.js";
export type { SandboxProcess, SpawnOptions } from "./spawn.js";
export { spawn } from "./spawn.js";
export type {
  FilesystemPolicy,
  NetworkPolicy,
  ResourceLimits,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxExecOptions,
  SandboxInstance,
  SandboxProfile,
  SandboxResult,
  SandboxTier,
} from "./types.js";
