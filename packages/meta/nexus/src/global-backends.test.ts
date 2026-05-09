import { describe, expect, mock, test } from "bun:test";

mock.module("@koi/registry-nexus", () => ({
  createNexusRegistry: mock(async () => ({ kind: "registry" })),
}));

mock.module("@koi/permissions-nexus", () => ({
  createNexusPermissionBackend: mock(() => ({ kind: "permissions" })),
}));

mock.module("@koi/audit-sink-nexus", () => ({
  createNexusAuditSink: mock(() => ({ kind: "audit" })),
}));

mock.module("@koi/search-nexus", () => ({
  createNexusSearch: mock(() => ({ kind: "search" })),
}));

mock.module("@koi/scheduler-nexus", () => ({
  createNexusSchedulerBackends: mock(() => ({ kind: "scheduler" })),
}));

describe("createGlobalBackends", () => {
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
