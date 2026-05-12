import { afterAll, describe, expect, mock, test } from "bun:test";

// Module mocks below use `mock.module()` which persists across files in the
// same bun process. Restore at the end so sibling integration tests can
// exercise real implementations.
afterAll(() => {
  mock.restore();
});

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
      healthCheck: async () => ({
        ok: true,
        value: { status: "ok", version: "1", latencyMs: 1, probed: ["version"] },
      }),
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
    expect(bundle.config.fallbackActive).toBe(false);
    expect(bundle.features.registry.mode).toBe("nexus");
    expect(bundle.features.audit.mode).toBe("disabled");
    await expect(bundle.dispose()).resolves.toBeUndefined();
    expect(mockDetach).toHaveBeenCalledTimes(1);
    expect(extraDispose).toHaveBeenCalledTimes(1);
  });

  test("reports feature detection for enabled, disabled, and opt-in surfaces", async () => {
    const { createNexusStack } = await import(
      `./nexus-stack.js?cacheBust=${Date.now()}-${Math.random()}`
    );

    const bundle = await createNexusStack({
      transport: { call: async () => ({ ok: true, value: {} }) } as never,
      enableScratchpad: true,
      enableWorkspace: true,
      global: { registry: true, permissions: false, audit: true, search: true, scheduler: false },
      healthCheck: async () => ({
        ok: true,
        value: { status: "ok", version: "1", latencyMs: 1, probed: ["version"] },
      }),
      globalFactories: {
        registry: async () => ({ kind: "registry" }),
        permissions: async () => ({ kind: "permissions" }),
        audit: async () => ({ kind: "audit" }),
        search: async () => ({ kind: "search" }),
        scheduler: async () => ({ kind: "scheduler" }),
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
    });

    expect(bundle.features.registry).toMatchObject({
      enabled: true,
      available: true,
      mode: "nexus",
    });
    expect(bundle.features.permissions).toMatchObject({
      enabled: false,
      available: false,
      mode: "disabled",
    });
    expect(bundle.features.workspace).toMatchObject({
      enabled: true,
      available: true,
      mode: "nexus",
    });
    expect(bundle.features.scratchpad).toMatchObject({
      enabled: true,
      available: true,
      mode: "nexus",
    });
  });

  test("falls back to local wiring when the Nexus transport is unhealthy at startup", async () => {
    const { createNexusStack } = await import(
      `./nexus-stack.js?cacheBust=${Date.now()}-${Math.random()}`
    );

    const bundle = await createNexusStack({
      transport: { call: async () => ({ ok: true, value: {} }) } as never,
      enableScratchpad: false,
      enableWorkspace: false,
      global: { registry: true, permissions: true, audit: false, search: false, scheduler: false },
      healthCheck: async () => ({
        ok: false,
        error: { code: "EXTERNAL", message: "nexus offline", retryable: true },
      }),
      globalFactories: {
        registry: async () => ({ kind: "nexus-registry" }),
        permissions: async () => ({ kind: "nexus-permissions" }),
        audit: async () => ({ kind: "nexus-audit" }),
        search: async () => ({ kind: "nexus-search" }),
        scheduler: async () => ({ kind: "nexus-scheduler" }),
      },
      fallback: {
        globalFactories: {
          registry: async () => ({ kind: "local-registry" }),
        },
        agentProvider: {
          createFileSystem: (agentId: string) => ({ kind: "local-filesystem", agentId }),
        },
      },
      agentProvider: {
        createFileSystem: (agentId: string) => ({ kind: "filesystem", agentId }),
        createMailbox: async (agentId: string) => ({ kind: "mailbox", agentId }),
        createSnapshotStore: (agentId: string) => ({ kind: "snapshot", agentId }),
        createPlaybookStore: (agentId: string) => ({ kind: "playbook", agentId }),
        createHandoffStore: (agentId: string) => ({ kind: "handoff", agentId }),
      },
    });

    expect(bundle.config.fallbackActive).toBe(true);
    expect(bundle.features.registry.mode).toBe("fallback");
    expect(bundle.features.permissions.mode).toBe("unavailable");
    expect(mockCreateGlobalBackends).toHaveBeenCalledWith(
      {
        registry: expect.any(Function),
        permissions: expect.any(Function),
        audit: expect.any(Function),
        search: expect.any(Function),
        scheduler: expect.any(Function),
      },
      { registry: true, permissions: false, audit: false, search: false, scheduler: false },
    );
    expect(bundle.backends.registry).toEqual({ kind: "registry" });
    expect(bundle.features.filesystem).toMatchObject({
      enabled: true,
      available: true,
      mode: "fallback",
    });

    const snapshot = await bundle.health();
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.dashboard.summary).toContain("local fallback active");
  });

  test("integrates transport health into the dashboard snapshot", async () => {
    const { createNexusStack } = await import(
      `./nexus-stack.js?cacheBust=${Date.now()}-${Math.random()}`
    );

    const bundle = await createNexusStack({
      transport: { call: async () => ({ ok: true, value: {} }) } as never,
      enableScratchpad: false,
      enableWorkspace: false,
      global: { registry: true, permissions: true, audit: false, search: false, scheduler: false },
      healthCheck: async () => ({
        ok: true,
        value: {
          status: "missing-paths",
          version: "1",
          latencyMs: 3,
          probed: ["version", "read:koi/permissions/policy.json"],
          notFound: ["koi/permissions/policy.json"],
        },
      }),
      globalFactories: {
        registry: async () => ({ kind: "registry" }),
        permissions: async () => ({ kind: "permissions" }),
        audit: async () => ({ kind: "audit" }),
        search: async () => ({ kind: "search" }),
        scheduler: async () => ({ kind: "scheduler" }),
      },
      agentProvider: {
        createFileSystem: (agentId: string) => ({ kind: "filesystem", agentId }),
        createMailbox: async (agentId: string) => ({ kind: "mailbox", agentId }),
        createSnapshotStore: (agentId: string) => ({ kind: "snapshot", agentId }),
        createPlaybookStore: (agentId: string) => ({ kind: "playbook", agentId }),
        createHandoffStore: (agentId: string) => ({ kind: "handoff", agentId }),
      },
    });

    const health = await bundle.health();
    expect(health.status).toBe("degraded");
    expect(health.dashboard.status).toBe("degraded");
    expect(health.dashboard.summary).toContain("missing probe paths");
    expect(health.dashboard.rows[0]).toMatchObject({
      key: "transport",
      status: "degraded",
      sourcePackage: "@koi/nexus-client",
    });
  });
});
