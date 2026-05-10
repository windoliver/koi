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

const AGENT_COMPONENTS = [
  ["filesystem", "createFileSystem"],
  ["mailbox", "createMailbox"],
  ["snapshot-store", "createSnapshotStore"],
  ["playbook-store", "createPlaybookStore"],
  ["handoff-store", "createHandoffStore"],
] as const satisfies readonly (readonly [string, keyof NexusAgentProviderConfig])[];

async function attachAgent(
  config: NexusAgentProviderConfig,
  agent: NexusAgentIdentity,
): Promise<{ components: Map<string, unknown>; skipped: string[] }> {
  const components = new Map<string, unknown>();
  const skipped: string[] = [];

  for (const [key, factoryKey] of AGENT_COMPONENTS) {
    const factory = config[factoryKey] as ((id: string) => unknown) | undefined;
    if (factory !== undefined) {
      components.set(key, await factory(agent.pid.id));
    } else {
      skipped.push(key);
    }
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
}

export function createNexusAgentProvider(config: NexusAgentProviderConfig): NexusAgentProvider {
  return {
    attach: (agent) => attachAgent(config, agent),
    detach: async () => {},
  };
}
