/**
 * Contract tests — verify each factory returns an object satisfying its L0 interface.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { delegationId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "../nexus-permission-backend.js";
import { createNexusRevocationRegistry } from "../nexus-revocation-registry.js";
import { createNexusScopeEnforcer } from "../nexus-scope-enforcer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): NexusClient {
  return {
    rpc: async <T>(method: string, params: Record<string, unknown>) => {
      if (method === "permissions.checkBatch") {
        const queries = params.queries as readonly unknown[];
        return {
          ok: true,
          value: {
            results: queries.map(() => ({ allowed: true })),
          } as unknown as T,
        } satisfies Result<T, KoiError>;
      }
      return {
        ok: true,
        value: { allowed: true, revoked: false } as unknown as T,
      } satisfies Result<T, KoiError>;
    },
  };
}

// ---------------------------------------------------------------------------
// PermissionBackend contract
// ---------------------------------------------------------------------------

describe("PermissionBackend contract", () => {
  test("has required check method", () => {
    const backend = createNexusPermissionBackend({
      client: createMockClient(),
    });

    expect(typeof backend.check).toBe("function");
  });

  test("has optional checkBatch method", () => {
    const backend = createNexusPermissionBackend({
      client: createMockClient(),
    });

    expect(typeof backend.checkBatch).toBe("function");
  });

  test("check returns valid PermissionDecision", async () => {
    const backend = createNexusPermissionBackend({
      client: createMockClient(),
    });

    const decision = await backend.check({
      principal: "agent:test",
      action: "read",
      resource: "/file.ts",
    });

    expect(["allow", "deny", "ask"]).toContain(decision.effect);
  });

  test("checkBatch returns array matching input length", async () => {
    const backend = createNexusPermissionBackend({
      client: createMockClient(),
    });

    const queries = [
      { principal: "a", action: "read", resource: "/a.ts" },
      { principal: "b", action: "write", resource: "/b.ts" },
      { principal: "c", action: "delete", resource: "/c.ts" },
    ];

    const results = await backend.checkBatch?.(queries);
    if (results === undefined) {
      throw new Error("checkBatch not defined");
    }

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(["allow", "deny", "ask"]).toContain(r.effect);
    }
  });
});

// ---------------------------------------------------------------------------
// RevocationRegistry contract
// ---------------------------------------------------------------------------

describe("RevocationRegistry contract", () => {
  test("has required isRevoked method", () => {
    const registry = createNexusRevocationRegistry({
      client: createMockClient(),
    });

    expect(typeof registry.isRevoked).toBe("function");
  });

  test("has required revoke method", () => {
    const registry = createNexusRevocationRegistry({
      client: createMockClient(),
    });

    expect(typeof registry.revoke).toBe("function");
  });

  test("has isRevokedBatch method", () => {
    const registry = createNexusRevocationRegistry({
      client: createMockClient(),
    });

    expect(typeof registry.isRevokedBatch).toBe("function");
  });

  test("isRevoked returns boolean", async () => {
    const registry = createNexusRevocationRegistry({
      client: createMockClient(),
    });

    const result = await registry.isRevoked(delegationId("test-id"));

    expect(typeof result).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// ScopeEnforcer contract
// ---------------------------------------------------------------------------

describe("ScopeEnforcer contract", () => {
  test("has required checkAccess method", () => {
    const enforcer = createNexusScopeEnforcer({
      backend: createNexusPermissionBackend({
        client: createMockClient(),
      }),
    });

    expect(typeof enforcer.checkAccess).toBe("function");
  });

  test("checkAccess returns boolean", async () => {
    const enforcer = createNexusScopeEnforcer({
      backend: createNexusPermissionBackend({
        client: createMockClient(),
      }),
    });

    const result = await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "read",
      resource: "/file.ts",
    });

    expect(typeof result).toBe("boolean");
  });
});
