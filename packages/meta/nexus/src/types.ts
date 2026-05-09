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
  readonly createFileSystem: (agentId: string) => unknown;
  readonly createMailbox: (agentId: string) => Promise<unknown>;
  readonly createSnapshotStore: (agentId: string) => unknown;
  readonly createPlaybookStore: (agentId: string) => unknown;
  readonly createHandoffStore: (agentId: string) => unknown;
  readonly createScratchpad: (groupId: string) => Awaitable<unknown>;
  readonly createWorkspace: (agentId: string) => Promise<unknown>;
  readonly enableScratchpad: boolean;
  readonly enableWorkspace: boolean;
}

export interface NexusStackConfig {
  readonly transport: unknown;
  readonly enableScratchpad: boolean;
  readonly enableWorkspace: boolean;
  readonly global: GlobalBackendFlags;
  readonly globalFactories: GlobalBackendFactories;
  readonly agentProvider: Omit<NexusAgentProviderConfig, "enableScratchpad" | "enableWorkspace">;
  readonly middlewares?: readonly unknown[];
  readonly dispose?: readonly (() => Awaitable<void>)[];
}

export interface NexusBundle {
  readonly backends: NexusGlobalBackends;
  readonly providers: readonly NexusAgentProvider[];
  readonly middlewares: readonly unknown[];
  readonly config: {
    readonly transportKind: "provided";
    readonly scratchpadEnabled: boolean;
    readonly workspaceEnabled: boolean;
  };
  readonly dispose: () => Promise<void>;
}
