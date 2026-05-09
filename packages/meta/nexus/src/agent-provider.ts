import { createNexusFileSystem } from "@koi/fs-nexus";
import { createNexusHandoffStore } from "@koi/handoff";
import { createNexusMailbox } from "@koi/ipc-nexus";
import { createPlaybookStoreNexus } from "@koi/playbook-store-nexus";
import { createNexusScratchpad } from "@koi/scratchpad-nexus";
import { createSnapshotStoreNexus } from "@koi/snapshot-store-nexus";
import { createNexusWorkspaceBackend } from "@koi/workspace-nexus";

export const liveAgentProviderImports = {
  createFileSystem: createNexusFileSystem,
  createMailbox: createNexusMailbox,
  createSnapshotStore: createSnapshotStoreNexus,
  createPlaybookStore: createPlaybookStoreNexus,
  createHandoffStore: createNexusHandoffStore,
  createScratchpad: createNexusScratchpad,
  createWorkspace: createNexusWorkspaceBackend,
};

export function createNexusAgentProvider(config: {
  readonly createFileSystem: (agentId: string) => unknown;
  readonly createMailbox: (agentId: string) => Promise<unknown>;
  readonly createSnapshotStore: (agentId: string) => unknown;
  readonly createPlaybookStore: (agentId: string) => unknown;
  readonly createHandoffStore: (agentId: string) => unknown;
  readonly createScratchpad: (groupId: string) => unknown;
  readonly createWorkspace: (agentId: string) => Promise<unknown>;
  readonly enableScratchpad: boolean;
  readonly enableWorkspace: boolean;
}) {
  return {
    async attach(agent: { pid: { id: string; groupId?: string } }) {
      const components = new Map<string, unknown>();
      components.set("filesystem", config.createFileSystem(agent.pid.id));
      components.set("mailbox", await config.createMailbox(agent.pid.id));
      components.set("snapshot-store", config.createSnapshotStore(agent.pid.id));
      components.set("playbook-store", config.createPlaybookStore(agent.pid.id));
      components.set("handoff-store", config.createHandoffStore(agent.pid.id));
      if (config.enableScratchpad && agent.pid.groupId) {
        components.set("scratchpad", config.createScratchpad(agent.pid.groupId));
      }
      if (config.enableWorkspace) {
        components.set("workspace", await config.createWorkspace(agent.pid.id));
      }
      return { components, skipped: [] };
    },
    async detach() {},
  };
}
