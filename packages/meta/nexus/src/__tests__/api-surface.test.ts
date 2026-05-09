import { describe, expect, mock, test } from "bun:test";

mock.module("@koi/fs-nexus", () => ({ createNexusFileSystem: mock(() => ({})) }));
mock.module("@koi/handoff", () => ({ createNexusHandoffStore: mock(() => ({})) }));
mock.module("@koi/ipc-nexus", () => ({ createNexusMailbox: mock(async () => ({})) }));
mock.module("@koi/playbook-store-nexus", () => ({ createPlaybookStoreNexus: mock(() => ({})) }));
mock.module("@koi/scratchpad-nexus", () => ({ createNexusScratchpad: mock(async () => ({})) }));
mock.module("@koi/snapshot-store-nexus", () => ({ createSnapshotStoreNexus: mock(() => ({})) }));
mock.module("@koi/workspace-nexus", () => ({
  createNexusWorkspaceBackend: mock(async () => ({})),
}));
mock.module("@koi/audit-sink-nexus", () => ({ createNexusAuditSink: mock(() => ({})) }));
mock.module("@koi/permissions-nexus", () => ({
  createNexusPermissionBackend: mock(() => ({})),
}));
mock.module("@koi/registry-nexus", () => ({ createNexusRegistry: mock(async () => ({})) }));
mock.module("@koi/scheduler-nexus", () => ({
  createNexusSchedulerBackends: mock(() => ({})),
}));
mock.module("@koi/search-nexus", () => ({ createNexusSearch: mock(() => ({})) }));

describe("@koi/nexus API surface", () => {
  test("exports createNexusStack and namespace helpers", async () => {
    const mod = await import(`../index.js?cacheBust=${Date.now()}-${Math.random()}`);
    expect(typeof mod.createNexusStack).toBe("function");
    expect(typeof mod.computeAgentNamespace).toBe("function");
    expect(typeof mod.computeGroupNamespace).toBe("function");
  });
});
