import { describe, expect, mock, test } from "bun:test";

const mockCreateGlobalBackends = mock(async () => ({
  registry: { kind: "registry" },
  permissions: { kind: "permissions" },
  search: { kind: "search" },
}));

const mockDetach = mock(async () => {});
const mockProvider = {
  attach: mock(async () => ({
    components: new Map<string, unknown>(),
    skipped: [],
  })),
  detach: mockDetach,
};

const mockCreateNexusAgentProvider = mock(() => mockProvider);

mock.module("./global-backends.js", () => ({
  createGlobalBackends: mockCreateGlobalBackends,
}));

mock.module("./agent-provider.js", () => ({
  createNexusAgentProvider: mockCreateNexusAgentProvider,
}));

describe("createNexusStack", () => {
  test("composes the global backends and agent provider into one bundle", async () => {
    const { createNexusStack } = await import(
      `./nexus-stack.js?cacheBust=${Date.now()}-${Math.random()}`
    );
    const extraDispose = mock(async () => {});
    const bundle = await createNexusStack({
      transport: { call: async () => ({ ok: true, value: {} }) } as never,
      enableScratchpad: true,
      enableWorkspace: false,
      global: { registry: true, permissions: true, audit: false, search: true, scheduler: true },
      globalFactories: {
        registry: async () => ({ kind: "live-registry" }),
        permissions: async () => ({ kind: "live-permissions" }),
        audit: async () => ({ kind: "live-audit" }),
        search: async () => ({ kind: "live-search" }),
        scheduler: async () => ({ kind: "live-scheduler" }),
      },
      agentProvider: {
        createFileSystem: (agentId: string) => ({ kind: "filesystem", agentId }),
        createMailbox: async (agentId: string) => ({ kind: "mailbox", agentId }),
        createSnapshotStore: (agentId: string) => ({ kind: "snapshot", agentId }),
        createPlaybookStore: (agentId: string) => ({ kind: "playbook", agentId }),
        createHandoffStore: (agentId: string) => ({ kind: "handoff", agentId }),
        createScratchpad: async (groupId: string) => ({ kind: "scratchpad", groupId }),
        createWorkspace: async (agentId: string) => ({ kind: "workspace", agentId }),
      },
      middlewares: [{ kind: "middleware" }],
      dispose: [extraDispose],
    });

    expect(mockCreateGlobalBackends).toHaveBeenCalledWith(
      {
        registry: expect.any(Function),
        permissions: expect.any(Function),
        audit: expect.any(Function),
        search: expect.any(Function),
        scheduler: expect.any(Function),
      },
      { registry: true, permissions: true, audit: false, search: true, scheduler: true },
    );
    expect(mockCreateNexusAgentProvider).toHaveBeenCalledWith({
      createFileSystem: expect.any(Function),
      createMailbox: expect.any(Function),
      createSnapshotStore: expect.any(Function),
      createPlaybookStore: expect.any(Function),
      createHandoffStore: expect.any(Function),
      createScratchpad: expect.any(Function),
      createWorkspace: expect.any(Function),
      enableScratchpad: true,
      enableWorkspace: false,
    });
    expect(bundle.backends).toEqual({
      registry: { kind: "registry" },
      permissions: { kind: "permissions" },
      search: { kind: "search" },
    });
    expect(bundle.providers).toEqual([mockProvider]);
    expect(bundle.middlewares).toEqual([{ kind: "middleware" }]);
    expect(bundle.config.workspaceEnabled).toBe(false);
    expect(bundle.config.scratchpadEnabled).toBe(true);
    await expect(bundle.dispose()).resolves.toBeUndefined();
    expect(mockDetach).toHaveBeenCalledTimes(1);
    expect(extraDispose).toHaveBeenCalledTimes(1);
  });
});
