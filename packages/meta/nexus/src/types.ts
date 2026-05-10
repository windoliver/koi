import type { KoiError, Result } from "@koi/core";
import type { NexusHealth, NexusTransport } from "@koi/nexus-client";

export interface AgentNamespace {
  readonly filesystem: string;
  readonly mailbox: string;
  readonly snapshotStore: string;
  readonly playbooks: string;
  readonly handoffs: string;
}

export interface GroupNamespace {
  readonly scratchpad: string;
}

export interface NexusGlobalBackends {
  readonly registry?: unknown;
  readonly permissions?: unknown;
  readonly audit?: unknown;
  readonly search?: unknown;
  readonly scheduler?: unknown;
}

export interface GlobalBackendFlags {
  readonly registry?: boolean;
  readonly permissions?: boolean;
  readonly audit?: boolean;
  readonly search?: boolean;
  readonly scheduler?: boolean;
}

type Awaitable<T> = T | Promise<T>;

export interface GlobalBackendFactories {
  readonly registry: () => Awaitable<unknown>;
  readonly permissions: () => Awaitable<unknown>;
  readonly audit: () => Awaitable<unknown>;
  readonly search: () => Awaitable<unknown>;
  readonly scheduler: () => Awaitable<unknown>;
}

export interface NexusAgentIdentity {
  readonly pid: {
    readonly id: string;
    readonly groupId?: string;
  };
}

export interface NexusAttachedProvider {
  readonly components: ReadonlyMap<string, unknown>;
  readonly skipped: readonly string[];
}

export interface NexusAgentProvider {
  readonly attach: (agent: NexusAgentIdentity) => Promise<NexusAttachedProvider>;
  readonly detach: () => Promise<void>;
}

export interface NexusAgentProviderConfig {
  readonly createFileSystem?: ((agentId: string) => unknown) | undefined;
  readonly createMailbox?: ((agentId: string) => Promise<unknown>) | undefined;
  readonly createSnapshotStore?: ((agentId: string) => unknown) | undefined;
  readonly createPlaybookStore?: ((agentId: string) => unknown) | undefined;
  readonly createHandoffStore?: ((agentId: string) => unknown) | undefined;
  readonly createScratchpad?: ((groupId: string) => Awaitable<unknown>) | undefined;
  readonly createWorkspace?: ((agentId: string) => Promise<unknown>) | undefined;
  readonly enableScratchpad: boolean;
  readonly enableWorkspace: boolean;
}

export type NexusFeatureScope = "global" | "agent" | "group" | "opt-in";

export type NexusFeatureMode = "nexus" | "fallback" | "disabled" | "unavailable";

export interface NexusFeatureSnapshot {
  readonly key: string;
  readonly scope: NexusFeatureScope;
  readonly sourcePackage: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly mode: NexusFeatureMode;
}

export interface NexusDashboardRow {
  readonly key: string;
  readonly label: string;
  readonly scope: NexusFeatureScope | "transport";
  readonly sourcePackage: string;
  readonly status: "ok" | "degraded" | "disabled" | "unhealthy";
  readonly mode: NexusFeatureMode | "probe";
}

export interface NexusHealthDashboard {
  readonly status: "ok" | "degraded" | "unhealthy";
  readonly summary: string;
  readonly rows: readonly NexusDashboardRow[];
}

export interface NexusHealthSnapshot {
  readonly status: "ok" | "degraded" | "unhealthy";
  readonly fallbackActive: boolean;
  readonly transport: Result<NexusHealth, KoiError> | undefined;
  readonly features: Readonly<Record<string, NexusFeatureSnapshot>>;
  readonly dashboard: NexusHealthDashboard;
}

export interface NexusFallbackConfig {
  readonly globalFactories?: Partial<GlobalBackendFactories> | undefined;
  readonly agentProvider?:
    | Partial<Omit<NexusAgentProviderConfig, "enableScratchpad" | "enableWorkspace">>
    | undefined;
}

export interface NexusStackConfig {
  readonly transport: NexusTransport;
  readonly enableScratchpad: boolean;
  readonly enableWorkspace: boolean;
  readonly global: GlobalBackendFlags;
  readonly globalFactories: GlobalBackendFactories;
  readonly agentProvider: Omit<NexusAgentProviderConfig, "enableScratchpad" | "enableWorkspace">;
  readonly healthCheck?: (() => Promise<Result<NexusHealth, KoiError>>) | undefined;
  readonly fallback?: NexusFallbackConfig | undefined;
  readonly middlewares?: readonly unknown[];
  readonly dispose?: readonly (() => Awaitable<void>)[];
}

export interface NexusBundle {
  readonly backends: NexusGlobalBackends;
  readonly providers: readonly NexusAgentProvider[];
  readonly middlewares: readonly unknown[];
  readonly features: Readonly<Record<string, NexusFeatureSnapshot>>;
  readonly config: {
    readonly transportKind: "provided";
    readonly scratchpadEnabled: boolean;
    readonly workspaceEnabled: boolean;
    readonly fallbackActive: boolean;
  };
  readonly health: () => Promise<NexusHealthSnapshot>;
  readonly dashboard: () => Promise<NexusHealthDashboard>;
  readonly dispose: () => Promise<void>;
}
