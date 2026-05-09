import { createNexusFileSystem } from "@koi/fs-nexus";
import { createNexusHandoffStore } from "@koi/handoff";
import { createNexusMailbox } from "@koi/ipc-nexus";
import { createPlaybookStoreNexus } from "@koi/playbook-store-nexus";
import { createNexusScratchpad } from "@koi/scratchpad-nexus";
import { createSnapshotStoreNexus } from "@koi/snapshot-store-nexus";
import { createNexusWorkspaceBackend } from "@koi/workspace-nexus";
import type { NexusAgentIdentity, NexusAgentProvider, NexusAgentProviderConfig } from "./types.js";

export const liveAgentProviderImports: Record<string, unknown> = {
  createFileSystem: createNexusFileSystem,
  createMailbox: createNexusMailbox,
  createSnapshotStore: createSnapshotStoreNexus,
  createPlaybookStore: createPlaybookStoreNexus,
  createHandoffStore: createNexusHandoffStore,
  createScratchpad: createNexusScratchpad,
  createWorkspace: createNexusWorkspaceBackend,
};

export function createNexusAgentProvider(config: NexusAgentProviderConfig): NexusAgentProvider {
  return {
    async attach(agent: NexusAgentIdentity) {
      const components = new Map<string, unknown>();
      components.set("filesystem", config.createFileSystem(agent.pid.id));
      components.set("mailbox", await config.createMailbox(agent.pid.id));
      components.set("snapshot-store", config.createSnapshotStore(agent.pid.id));
      components.set("playbook-store", config.createPlaybookStore(agent.pid.id));
      components.set("handoff-store", config.createHandoffStore(agent.pid.id));
      if (config.enableScratchpad && agent.pid.groupId) {
        components.set("scratchpad", await config.createScratchpad(agent.pid.groupId));
      }
      if (config.enableWorkspace) {
        components.set("workspace", await config.createWorkspace(agent.pid.id));
      }
      return { components, skipped: [] };
    },
    async detach() {},
  };
}
