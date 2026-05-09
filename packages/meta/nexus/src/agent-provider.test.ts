import { describe, expect, mock, test } from "bun:test";

const mockCreateNexusFileSystem = mock((agentId: string) => ({ kind: "fs", agentId }));
const mockCreateNexusMailbox = mock(async (agentId: string) => ({ kind: "mailbox", agentId }));
const mockCreateSnapshotStoreNexus = mock((agentId: string) => ({ kind: "snapshot", agentId }));
const mockCreatePlaybookStoreNexus = mock((agentId: string) => ({ kind: "playbook", agentId }));
const mockCreateNexusHandoffStore = mock((agentId: string) => ({ kind: "handoff", agentId }));
const mockCreateNexusScratchpad = mock(async (groupId: string) => ({
  kind: "scratchpad",
  groupId,
}));
const mockCreateNexusWorkspaceBackend = mock(async (agentId: string) => ({
  kind: "workspace",
  agentId,
}));

mock.module("@koi/fs-nexus", () => ({
  createNexusFileSystem: mockCreateNexusFileSystem,
}));

mock.module("@koi/ipc-nexus", () => ({
  createNexusMailbox: mockCreateNexusMailbox,
}));

mock.module("@koi/snapshot-store-nexus", () => ({
  createSnapshotStoreNexus: mockCreateSnapshotStoreNexus,
}));

mock.module("@koi/playbook-store-nexus", () => ({
  createPlaybookStoreNexus: mockCreatePlaybookStoreNexus,
}));

mock.module("@koi/handoff", () => ({
  createNexusHandoffStore: mockCreateNexusHandoffStore,
}));

mock.module("@koi/scratchpad-nexus", () => ({
  createNexusScratchpad: mockCreateNexusScratchpad,
}));

mock.module("@koi/workspace-nexus", () => ({
  createNexusWorkspaceBackend: mockCreateNexusWorkspaceBackend,
}));

describe("createNexusAgentProvider", () => {
  test("exports only live v2 agent-scoped factories", async () => {
    const { liveAgentProviderImports } = await import(
      `./agent-provider.js?cacheBust=${Date.now()}-${Math.random()}`
    );

    expect(liveAgentProviderImports).toEqual({
      createFileSystem: mockCreateNexusFileSystem,
      createMailbox: mockCreateNexusMailbox,
      createSnapshotStore: mockCreateSnapshotStoreNexus,
      createPlaybookStore: mockCreatePlaybookStoreNexus,
      createHandoffStore: mockCreateNexusHandoffStore,
      createScratchpad: mockCreateNexusScratchpad,
      createWorkspace: mockCreateNexusWorkspaceBackend,
    });
  });

  test("attaches only live v2 agent-scoped stores and gates optional group/workspace wiring", async () => {
    const { createNexusAgentProvider } = await import(
      `./agent-provider.js?cacheBust=${Date.now()}-${Math.random()}`
    );

    const provider = createNexusAgentProvider({
      createFileSystem: (agentId) => ({ kind: "fs", agentId }),
      createMailbox: async (agentId) => ({ kind: "mailbox", agentId }),
      createSnapshotStore: (agentId) => ({ kind: "snapshot", agentId }),
      createPlaybookStore: (agentId) => ({ kind: "playbook", agentId }),
      createHandoffStore: (agentId) => ({ kind: "handoff", agentId }),
      createScratchpad: (groupId) => ({ kind: "scratchpad", groupId }),
      createWorkspace: async (agentId) => ({ kind: "workspace", agentId }),
      enableScratchpad: true,
      enableWorkspace: false,
    });

    const attached = await provider.attach({
      pid: { id: "agent-1", groupId: "group-1" },
    } as never);

    expect(attached.components.get("filesystem")).toBeDefined();
    expect(attached.components.get("mailbox")).toBeDefined();
    expect(attached.components.get("snapshot-store")).toBeDefined();
    expect(attached.components.get("playbook-store")).toBeDefined();
    expect(attached.components.get("handoff-store")).toBeDefined();
    expect(attached.components.get("scratchpad")).toBeDefined();
    expect(attached.components.get("workspace")).toBeUndefined();
  });
});
