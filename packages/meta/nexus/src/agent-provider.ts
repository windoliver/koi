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
      const skipped: string[] = [];

      if (config.createFileSystem !== undefined) {
        components.set("filesystem", config.createFileSystem(agent.pid.id));
      } else {
        skipped.push("filesystem");
      }

      if (config.createMailbox !== undefined) {
        components.set("mailbox", await config.createMailbox(agent.pid.id));
      } else {
        skipped.push("mailbox");
      }

      if (config.createSnapshotStore !== undefined) {
        components.set("snapshot-store", config.createSnapshotStore(agent.pid.id));
      } else {
        skipped.push("snapshot-store");
      }

      if (config.createPlaybookStore !== undefined) {
        components.set("playbook-store", config.createPlaybookStore(agent.pid.id));
      } else {
        skipped.push("playbook-store");
      }

      if (config.createHandoffStore !== undefined) {
        components.set("handoff-store", config.createHandoffStore(agent.pid.id));
      } else {
        skipped.push("handoff-store");
      }

      if (
        config.enableScratchpad &&
        agent.pid.groupId !== undefined &&
        config.createScratchpad !== undefined
      ) {
        components.set("scratchpad", await config.createScratchpad(agent.pid.groupId));
      } else if (config.enableScratchpad) {
        skipped.push("scratchpad");
      }

      if (config.enableWorkspace && config.createWorkspace !== undefined) {
        components.set("workspace", await config.createWorkspace(agent.pid.id));
      } else if (config.enableWorkspace) {
        skipped.push("workspace");
      }

      return { components, skipped };
    },
    async detach() {},
  };
}
