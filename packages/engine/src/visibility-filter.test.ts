import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentRegistry,
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
  RegistryEntry,
  RegistryFilter,
  VisibilityContext,
} from "@koi/core";
import { agentId, zoneId } from "@koi/core";
import { createVisibilityFilter } from "./visibility-filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(id: string): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
  };
}

function createStubRegistry(entries: readonly RegistryEntry[] = []): AgentRegistry {
  return {
    register: mock(async (e: RegistryEntry) => e),
    deregister: mock(async () => true),
    lookup: mock(async (id) => entries.find((e) => e.agentId === id)),
    list: mock(async () => entries),
    transition: mock(async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "stub", retryable: false },
    })),
    patch: mock(async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "stub", retryable: false },
    })),
    watch: mock(() => () => {}),
    [Symbol.asyncDispose]: mock(async () => {}),
  };
}

function createStubPermissions(
  decisionFn: (query: PermissionQuery) => PermissionDecision,
  opts?: { readonly useBatch?: boolean },
): PermissionBackend {
  const backend: PermissionBackend = {
    check: mock((q: PermissionQuery) => decisionFn(q)),
  };

  if (opts?.useBatch) {
    return {
      ...backend,
      checkBatch: mock((queries: readonly PermissionQuery[]) => queries.map((q) => decisionFn(q))),
    };
  }
  return backend;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVisibilityFilter", () => {
  const e1 = entry("agent-a");
  const e2 = entry("agent-b");
  const e3 = entry("agent-c");
  const visibility: VisibilityContext = { callerId: agentId("caller-1") };

  // -----------------------------------------------------------------------
  // Delegation
  // -----------------------------------------------------------------------

  describe("delegation", () => {
    test("delegates register to inner registry", async () => {
      const inner = createStubRegistry();
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      await filtered.register(e1);
      expect(inner.register).toHaveBeenCalledWith(e1);
    });

    test("delegates deregister to inner registry", async () => {
      const inner = createStubRegistry();
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      await filtered.deregister(agentId("agent-a"));
      expect(inner.deregister).toHaveBeenCalledWith(agentId("agent-a"));
    });

    test("delegates lookup to inner registry", async () => {
      const inner = createStubRegistry([e1]);
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.lookup(agentId("agent-a"));
      expect(result).toBeDefined();
      expect(inner.lookup).toHaveBeenCalledWith(agentId("agent-a"));
    });

    test("delegates transition to inner registry", async () => {
      const inner = createStubRegistry();
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      await filtered.transition(agentId("agent-a"), "terminated", 1, { kind: "completed" });
      expect(inner.transition).toHaveBeenCalled();
    });

    test("delegates patch to inner registry", async () => {
      const inner = createStubRegistry();
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      await filtered.patch(agentId("agent-a"), { priority: 5 });
      expect(inner.patch).toHaveBeenCalledWith(agentId("agent-a"), { priority: 5 });
    });

    test("delegates watch to inner registry", () => {
      const inner = createStubRegistry();
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      const listener = () => {};
      filtered.watch(listener);
      expect(inner.watch).toHaveBeenCalledWith(listener);
    });
  });

  // -----------------------------------------------------------------------
  // No VisibilityContext (migration)
  // -----------------------------------------------------------------------

  describe("no VisibilityContext", () => {
    test("returns all entries when no VisibilityContext (fail-open migration)", async () => {
      const inner = createStubRegistry([e1, e2]);
      const perms = createStubPermissions(() => ({ effect: "deny", reason: "nope" }));
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list();
      expect(result).toHaveLength(2);
    });

    test("returns empty when no VisibilityContext and strictVisibility is true", async () => {
      const inner = createStubRegistry([e1, e2]);
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms, { strictVisibility: true });

      const result = await filtered.list();
      expect(result).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Permission filtering
  // -----------------------------------------------------------------------

  describe("permission filtering", () => {
    test("filters entries by permission — allow passes, deny filtered", async () => {
      const inner = createStubRegistry([e1, e2]);
      const perms = createStubPermissions((q) =>
        q.resource === `agent:${e1.agentId}`
          ? { effect: "allow" }
          : { effect: "deny", reason: "forbidden" },
      );
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list(undefined, visibility);
      expect(result).toHaveLength(1);
      expect(result[0]?.agentId).toBe(e1.agentId);
    });

    test("treats 'ask' decision as deny", async () => {
      const inner = createStubRegistry([e1]);
      const perms = createStubPermissions(() => ({ effect: "ask", reason: "needs approval" }));
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list(undefined, visibility);
      expect(result).toHaveLength(0);
    });

    test("mixed allow/deny batch returns only allowed entries", async () => {
      const inner = createStubRegistry([e1, e2, e3]);
      const allowSet = new Set([`agent:${e1.agentId}`, `agent:${e3.agentId}`]);
      const perms = createStubPermissions((q) =>
        allowSet.has(q.resource) ? { effect: "allow" } : { effect: "deny", reason: "no" },
      );
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list(undefined, visibility);
      expect(result).toHaveLength(2);
      expect(result.map((e: RegistryEntry) => e.agentId)).toEqual([e1.agentId, e3.agentId]);
    });
  });

  // -----------------------------------------------------------------------
  // checkBatch support
  // -----------------------------------------------------------------------

  describe("checkBatch", () => {
    test("uses checkBatch when available on backend", async () => {
      const inner = createStubRegistry([e1, e2]);
      const perms = createStubPermissions(() => ({ effect: "allow" }), { useBatch: true });
      const filtered = createVisibilityFilter(inner, perms);

      await filtered.list(undefined, visibility);
      expect(perms.checkBatch).toHaveBeenCalled();
      expect(perms.check).not.toHaveBeenCalled();
    });

    test("falls back to individual check() via Promise.all when checkBatch absent", async () => {
      const inner = createStubRegistry([e1, e2]);
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      await filtered.list(undefined, visibility);
      expect(perms.check).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling (fail-closed)
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    let warnSpy: ReturnType<typeof mock>;
    let originalWarn: typeof console.warn;

    beforeEach(() => {
      originalWarn = console.warn;
      warnSpy = mock(() => {});
      console.warn = warnSpy;
    });

    afterEach(() => {
      console.warn = originalWarn;
    });

    test("returns empty array when permission backend throws (fail-closed)", async () => {
      const inner = createStubRegistry([e1]);
      const perms: PermissionBackend = {
        check: () => {
          throw new Error("backend down");
        },
      };
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list(undefined, visibility);
      expect(result).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    test("returns empty array when permission backend rejects (fail-closed)", async () => {
      const inner = createStubRegistry([e1]);
      const perms: PermissionBackend = {
        check: () => Promise.reject(new Error("network error")),
      };
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list(undefined, visibility);
      expect(result).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // PermissionQuery shape
  // -----------------------------------------------------------------------

  describe("PermissionQuery shape", () => {
    test("passes correct PermissionQuery shape", async () => {
      const inner = createStubRegistry([e1]);
      const queries: PermissionQuery[] = [];
      const perms: PermissionBackend = {
        check: (q: PermissionQuery) => {
          queries.push(q);
          return { effect: "allow" };
        },
      };
      const filtered = createVisibilityFilter(inner, perms);

      await filtered.list(undefined, visibility);

      expect(queries).toHaveLength(1);
      expect(queries[0]).toEqual({
        principal: visibility.callerId,
        action: "discover",
        resource: `agent:${e1.agentId}`,
      });
    });

    test("includes callerZoneId in context when provided", async () => {
      const inner = createStubRegistry([e1]);
      const queries: PermissionQuery[] = [];
      const perms: PermissionBackend = {
        check: (q: PermissionQuery) => {
          queries.push(q);
          return { effect: "allow" };
        },
      };
      const filtered = createVisibilityFilter(inner, perms);

      const visibilityWithZone: VisibilityContext = {
        callerId: agentId("caller-1"),
        callerZoneId: zoneId("zone-alpha"),
      };

      await filtered.list(undefined, visibilityWithZone);

      expect(queries[0]?.context).toEqual({ callerZoneId: zoneId("zone-alpha") });
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    test("empty registry returns empty array regardless of visibility", async () => {
      const inner = createStubRegistry([]);
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list(undefined, visibility);
      expect(result).toHaveLength(0);
      // Permission check should not be called for empty list
      expect(perms.check).not.toHaveBeenCalled();
    });

    test("applies data filter before permission filter", async () => {
      const worker = entry("worker-1");
      const copilot: RegistryEntry = {
        ...entry("copilot-1"),
        agentType: "copilot",
      };

      // Inner registry returns filtered results (only workers when filter applied)
      const inner: AgentRegistry = {
        ...createStubRegistry([worker, copilot]),
        list: mock(async (filter?: RegistryFilter) => {
          const all = [worker, copilot];
          if (filter?.agentType !== undefined) {
            return all.filter((e: RegistryEntry) => e.agentType === filter.agentType);
          }
          return all;
        }),
      };

      // Allow all
      const perms = createStubPermissions(() => ({ effect: "allow" }));
      const filtered = createVisibilityFilter(inner, perms);

      const result = await filtered.list({ agentType: "worker" }, visibility);
      expect(result).toHaveLength(1);
      expect(result[0]?.agentId).toBe(worker.agentId);
      // Only one permission check (for the filtered worker), not two
      expect(perms.check).toHaveBeenCalledTimes(1);
    });
  });
});
