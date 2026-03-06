/**
 * Types for the IPC meta-package bundle.
 *
 * Defines IpcStackConfig (preset + subsystem fields),
 * deployment presets, and the IpcBundle return shape.
 */

import type { ComponentProvider, KoiMiddleware, SpawnFn } from "@koi/core";
import type {
  FederationMiddlewareConfig,
  SyncEngineConfig,
  SyncEngineHandle,
} from "@koi/federation";
import type { LocalMailboxConfig, MailboxRouter } from "@koi/ipc-local";
import type { IpcNexusProviderConfig } from "@koi/ipc-nexus";
import type { LocalScratchpadConfig } from "@koi/scratchpad-local";
import type { ScratchpadNexusProviderConfig } from "@koi/scratchpad-nexus";
import type { TaskSpawnConfig } from "@koi/task-spawn";
import type { WorkspaceProviderConfig } from "@koi/workspace";

// ---------------------------------------------------------------------------
// Deployment presets
// ---------------------------------------------------------------------------

/** Deployment preset levels for IPC stacks. */
export type IpcPreset = "local" | "cloud" | "hybrid";

// ---------------------------------------------------------------------------
// Stack configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the IPC meta-package stack.
 *
 * All subsystem fields are optional. When `preset` is specified, its defaults
 * are merged under user overrides. The `spawn` field is always required —
 * it bridges L2 delegation packages to L1 runtime.
 */
export interface IpcStackConfig {
  // ── Meta ──────────────────────────────────────────────────────────────
  /** Deployment preset. Defaults to "local". */
  readonly preset?: IpcPreset | undefined;
  /** Unified spawn function — required for delegation subsystems. */
  readonly spawn: SpawnFn;

  // ── Messaging ─────────────────────────────────────────────────────────
  /** Messaging subsystem configuration. */
  readonly messaging?:
    | { readonly kind: "local"; readonly config?: Omit<LocalMailboxConfig, "agentId"> | undefined }
    | { readonly kind: "nexus"; readonly config?: IpcNexusProviderConfig | undefined }
    | undefined;

  // ── Delegation ────────────────────────────────────────────────────────
  /** Delegation subsystem configuration. */
  readonly delegation?:
    | { readonly kind: "task-spawn"; readonly config?: Omit<TaskSpawnConfig, "spawn"> | undefined }
    | undefined;

  // ── Workspace ─────────────────────────────────────────────────────────
  /** Workspace isolation configuration. */
  readonly workspace?: WorkspaceProviderConfig | undefined;

  // ── Scratchpad ────────────────────────────────────────────────────────
  /** Scratchpad subsystem configuration. */
  readonly scratchpad?:
    | { readonly kind: "local"; readonly config: LocalScratchpadConfig }
    | { readonly kind: "nexus"; readonly config: ScratchpadNexusProviderConfig }
    | undefined;

  // ── Federation ────────────────────────────────────────────────────────
  /** Federation subsystem configuration. */
  readonly federation?:
    | {
        readonly middleware?: FederationMiddlewareConfig | undefined;
        readonly sync?: SyncEngineConfig | undefined;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Preset spec
// ---------------------------------------------------------------------------

/**
 * Partial config without meta-fields, used for preset definitions.
 * Presets cannot specify spawn, workspace, scratchpad, or federation
 * (those require user-specific config).
 */
export type IpcPresetSpec = Partial<
  Omit<IpcStackConfig, "preset" | "spawn" | "workspace" | "scratchpad" | "federation">
>;

// ---------------------------------------------------------------------------
// Resolved metadata
// ---------------------------------------------------------------------------

/** Metadata about the resolved IPC stack for inspection. */
export interface ResolvedIpcMeta {
  readonly preset: IpcPreset;
  readonly messagingKind: "local" | "nexus" | "none";
  readonly delegationKind: "task-spawn" | "none";
  readonly scratchpadKind: "local" | "nexus" | "none";
  readonly workspaceEnabled: boolean;
  readonly federationEnabled: boolean;
  readonly providerCount: number;
  readonly middlewareCount: number;
}

// ---------------------------------------------------------------------------
// Bundle return value
// ---------------------------------------------------------------------------

/** Return value of createIpcStack(). */
export interface IpcBundle {
  readonly providers: readonly ComponentProvider[];
  readonly middlewares: readonly KoiMiddleware[];
  readonly disposables: readonly Disposable[];
  readonly config: ResolvedIpcMeta;
  /** Local mailbox router — present when messaging.kind = "local". */
  readonly router?: MailboxRouter;
  /** Sync engine handle — present when federation.sync is configured. */
  readonly syncEngine?: SyncEngineHandle;
}
