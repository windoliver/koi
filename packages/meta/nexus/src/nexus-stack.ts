import type { NexusBundle } from "./types.js";

const LIVE_GLOBAL_SURFACES = {
  registry: "@koi/registry-nexus",
  permissions: "@koi/permissions-nexus",
  audit: "@koi/audit-sink-nexus",
  search: "@koi/search-nexus",
  scheduler: "@koi/scheduler-nexus",
} as const;

const LIVE_AGENT_SURFACES = {
  filesystem: "@koi/fs-nexus",
  mailbox: "@koi/ipc-nexus",
  scratchpad: "@koi/scratchpad-nexus",
  workspace: "@koi/workspace-nexus",
  snapshotStore: "@koi/snapshot-store-nexus",
  playbookStore: "@koi/playbook-store-nexus",
  handoffStore: "@koi/handoff",
} as const;

const OUT_OF_SCOPE_SURFACES = [
  "@koi/nexus-store",
  "@koi/filesystem-nexus",
  "@koi/pay-nexus",
  "@koi/name-service-nexus",
] as const;

void OUT_OF_SCOPE_SURFACES;

export async function createNexusStack(config: {
  readonly transport: unknown;
  readonly enableScratchpad: boolean;
  readonly enableWorkspace: boolean;
  readonly global: {
    readonly registry?: boolean;
    readonly permissions?: boolean;
    readonly audit?: boolean;
    readonly search?: boolean;
    readonly scheduler?: boolean;
  };
}): Promise<NexusBundle> {
  void config.transport;
  return {
    backends: {
      ...(config.global.registry === false
        ? {}
        : { registry: { surface: LIVE_GLOBAL_SURFACES.registry } }),
      ...(config.global.permissions === false
        ? {}
        : { permissions: { surface: LIVE_GLOBAL_SURFACES.permissions } }),
      ...(config.global.audit === false ? {} : { audit: { surface: LIVE_GLOBAL_SURFACES.audit } }),
      ...(config.global.search === false
        ? {}
        : { search: { surface: LIVE_GLOBAL_SURFACES.search } }),
      ...(config.global.scheduler === false
        ? {}
        : { scheduler: { surface: LIVE_GLOBAL_SURFACES.scheduler } }),
    },
    providers: [
      {
        surface: "@koi/nexus-agent-provider",
        components: [
          { key: "filesystem", surface: LIVE_AGENT_SURFACES.filesystem },
          { key: "mailbox", surface: LIVE_AGENT_SURFACES.mailbox },
          { key: "snapshot-store", surface: LIVE_AGENT_SURFACES.snapshotStore },
          { key: "playbook-store", surface: LIVE_AGENT_SURFACES.playbookStore },
          { key: "handoff-store", surface: LIVE_AGENT_SURFACES.handoffStore },
          ...(config.enableScratchpad
            ? [{ key: "scratchpad", surface: LIVE_AGENT_SURFACES.scratchpad }]
            : []),
          ...(config.enableWorkspace
            ? [{ key: "workspace", surface: LIVE_AGENT_SURFACES.workspace }]
            : []),
        ],
      },
    ],
    middlewares: [],
    config: {
      transportKind: "provided",
      scratchpadEnabled: config.enableScratchpad,
      workspaceEnabled: config.enableWorkspace,
    },
    dispose: async () => {},
  };
}
