import { describe, expect, test } from "bun:test";
import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";
import { createNexusScopeEnforcer } from "./nexus-scope-enforcer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBackend(
  handler: (query: PermissionQuery) => PermissionDecision,
): PermissionBackend {
  return {
    check: (query: PermissionQuery) => handler(query),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusScopeEnforcer", () => {
  test("maps ScopeAccessRequest to PermissionQuery correctly", async () => {
    let capturedQuery: PermissionQuery | undefined;
    const enforcer = createNexusScopeEnforcer({
      backend: createMockBackend((query) => {
        capturedQuery = query;
        return { effect: "allow" };
      }),
    });

    await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "write",
      resource: "/src/main.ts",
      context: { agentId: "agent:coder" },
    });

    expect(capturedQuery).toEqual({
      principal: "agent:coder",
      action: "write",
      resource: "/src/main.ts",
    });
  });

  test("returns true when backend allows", async () => {
    const enforcer = createNexusScopeEnforcer({
      backend: createMockBackend(() => ({ effect: "allow" })),
    });

    const result = await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "read",
      resource: "/src/file.ts",
    });

    expect(result).toBe(true);
  });

  test("returns false when backend denies", async () => {
    const enforcer = createNexusScopeEnforcer({
      backend: createMockBackend(() => ({ effect: "deny", reason: "not allowed" })),
    });

    const result = await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "delete",
      resource: "/etc/passwd",
    });

    expect(result).toBe(false);
  });

  test("returns false when backend asks", async () => {
    const enforcer = createNexusScopeEnforcer({
      backend: createMockBackend(() => ({ effect: "ask", reason: "requires approval" })),
    });

    const result = await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "write",
      resource: "/config/settings.json",
    });

    expect(result).toBe(false);
  });

  test("uses 'anonymous' when no agentId in context", async () => {
    let capturedQuery: PermissionQuery | undefined;
    const enforcer = createNexusScopeEnforcer({
      backend: createMockBackend((query) => {
        capturedQuery = query;
        return { effect: "allow" };
      }),
    });

    await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "read",
      resource: "/file.ts",
    });

    expect(capturedQuery?.principal).toBe("anonymous");
  });

  test("all filesystem operations produce correct action", async () => {
    const ops = ["read", "list", "search", "write", "edit", "delete", "rename"];
    const captured: string[] = [];

    const enforcer = createNexusScopeEnforcer({
      backend: createMockBackend((query) => {
        captured.push(query.action);
        return { effect: "allow" };
      }),
    });

    for (const op of ops) {
      await enforcer.checkAccess({
        subsystem: "filesystem",
        operation: op,
        resource: "/file.ts",
      });
    }

    expect(captured).toEqual(ops);
  });

  test("propagates dispose from backend", async () => {
    let disposed = false;
    const backend: PermissionBackend = {
      check: () => ({ effect: "allow" }),
      dispose: () => {
        disposed = true;
      },
    };

    const enforcer = createNexusScopeEnforcer({ backend });
    await enforcer.dispose?.();

    expect(disposed).toBe(true);
  });

  test("omits dispose when backend has none", () => {
    const enforcer = createNexusScopeEnforcer({
      backend: { check: () => ({ effect: "allow" }) },
    });

    expect(enforcer.dispose).toBeUndefined();
  });
});
