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

export interface NexusBundle {
  readonly backends: NexusGlobalBackends;
  readonly providers: readonly unknown[];
  readonly middlewares: readonly unknown[];
  readonly config: {
    readonly transportKind: "provided";
    readonly scratchpadEnabled: boolean;
    readonly workspaceEnabled: boolean;
  };
  readonly dispose: () => Promise<void>;
}
