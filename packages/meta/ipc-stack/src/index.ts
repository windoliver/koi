/**
 * @koi/ipc-stack — IPC meta-package (Layer 3)
 *
 * One-line IPC subsystem for agent deployments.
 * Composes messaging, delegation, workspace, scratchpad, and federation
 * via createIpcStack():
 *
 * Usage:
 * ```typescript
 * import { createIpcStack } from "@koi/ipc-stack";
 *
 * const { providers, middlewares, router, config } = createIpcStack({
 *   preset: "local",
 *   spawn: mySpawnFn,
 * });
 * const runtime = await createKoi({ ..., middleware: middlewares, providers });
 * ```
 */

// ── Types: sub-package configs ──────────────────────────────────────────
export type {
  FederationMiddlewareConfig,
  SyncEngineConfig,
  SyncEngineHandle,
} from "@koi/federation";
export type { LocalMailboxConfig, MailboxRouter } from "@koi/ipc-local";
export type { IpcNexusProviderConfig } from "@koi/ipc-nexus";
export type { OrchestratorConfig } from "@koi/orchestrator";
export type { ParallelMinionsConfig } from "@koi/parallel-minions";
export type { LocalScratchpadConfig } from "@koi/scratchpad-local";
export type { ScratchpadNexusProviderConfig } from "@koi/scratchpad-nexus";
export type { TaskSpawnConfig } from "@koi/task-spawn";
export type { WorkspaceProviderConfig } from "@koi/workspace";
// ── Functions ───────────────────────────────────────────────────────────
export { resolveIpcConfig } from "./config-resolution.js";
export { createIpcStack } from "./ipc-stack.js";
// ── Constants ───────────────────────────────────────────────────────────
export { IPC_PRESET_SPECS } from "./presets.js";
// ── Types: IPC bundle ───────────────────────────────────────────────────
export type {
  IpcBundle,
  IpcPreset,
  IpcPresetSpec,
  IpcStackConfig,
  ResolvedIpcMeta,
} from "./types.js";
