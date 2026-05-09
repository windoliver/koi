import { describe, expect, mock, test } from "bun:test";

const mockCreateNexusRegistry = mock(async () => ({ kind: "registry" }));
const mockCreateNexusPermissionBackend = mock(() => ({ kind: "permissions" }));
const mockCreateNexusAuditSink = mock(() => ({ kind: "audit" }));
const mockCreateNexusSearch = mock(() => ({ kind: "search" }));
const mockCreateNexusSchedulerBackends = mock(() => ({ kind: "scheduler" }));

mock.module("@koi/registry-nexus", () => ({
  createNexusRegistry: mockCreateNexusRegistry,
}));

mock.module("@koi/permissions-nexus", () => ({
  createNexusPermissionBackend: mockCreateNexusPermissionBackend,
}));

mock.module("@koi/audit-sink-nexus", () => ({
  createNexusAuditSink: mockCreateNexusAuditSink,
}));

mock.module("@koi/search-nexus", () => ({
  createNexusSearch: mockCreateNexusSearch,
}));

mock.module("@koi/scheduler-nexus", () => ({
  createNexusSchedulerBackends: mockCreateNexusSchedulerBackends,
}));

describe("createGlobalBackends", () => {
  test("exports the live v2 singleton creators without archive-only names", async () => {
    const { liveGlobalBackendImports } = await import(
      `./global-backends.js?cacheBust=${Date.now()}-${Math.random()}`
    );

    expect(liveGlobalBackendImports).toEqual({
      registry: mockCreateNexusRegistry,
      permissions: mockCreateNexusPermissionBackend,
      audit: mockCreateNexusAuditSink,
      search: mockCreateNexusSearch,
      scheduler: mockCreateNexusSchedulerBackends,
    });
    expect("pay" in liveGlobalBackendImports).toBe(false);
    expect("nameService" in liveGlobalBackendImports).toBe(false);
  });

  test("only wires live v2 singleton packages and omits archive-only names", async () => {
    const { createGlobalBackends } = await import(
      `./global-backends.js?cacheBust=${Date.now()}-${Math.random()}`
    );
    const created: string[] = [];
    const track = (name: string) => {
      created.push(name);
      return { kind: name };
    };
    const backends = await createGlobalBackends(
      {
        registry: async () => track("registry"),
        permissions: () => track("permissions"),
        audit: () => track("audit"),
        search: () => track("search"),
        scheduler: () => track("scheduler"),
      },
      { registry: true, permissions: true, audit: false, search: true, scheduler: true },
    );

    expect(created).toEqual(["registry", "permissions", "search", "scheduler"]);
    expect(backends.audit).toBeUndefined();
    expect("pay" in backends).toBe(false);
    expect("nameService" in backends).toBe(false);
  });
});
