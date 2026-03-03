/**
 * Escalation prevention tests for DelegationManager.
 *
 * Verifies that when a permissionBackend is configured, the manager enforces
 * that grantors only delegate permissions they themselves hold. Tests batch
 * vs. sequential check paths, fail-closed behavior, and attenuate coverage.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DelegationManager — escalation prevention", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      fn();
    }
    cleanups.length = 0;
  });

  function createManager(
    overrides?: Partial<Parameters<typeof createDelegationManager>[0]>,
  ): ReturnType<typeof createDelegationManager> {
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      ...overrides,
    });
    cleanups.push(manager.dispose);
    return manager;
  }

  // -------------------------------------------------------------------------
  // 1. Allow path — batch check
  // -------------------------------------------------------------------------

  test("allows grant when grantor holds all permissions", async () => {
    const backend: PermissionBackend = {
      check: async (_query: PermissionQuery): Promise<PermissionDecision> => ({
        effect: "allow",
      }),
      checkBatch: async (
        queries: readonly PermissionQuery[],
      ): Promise<readonly PermissionDecision[]> =>
        queries.map(() => ({ effect: "allow" as const })),
    };

    const manager = createManager({ permissionBackend: backend });

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issuerId).toBe(agentId("agent-1"));
    expect(result.value.delegateeId).toBe(agentId("agent-2"));
  });

  // -------------------------------------------------------------------------
  // 2. Deny path — grantor lacks permission
  // -------------------------------------------------------------------------

  test("denies grant when grantor lacks a permission", async () => {
    const backend: PermissionBackend = {
      check: async (_query: PermissionQuery): Promise<PermissionDecision> => ({
        effect: "deny",
        reason: "not authorized",
      }),
      checkBatch: async (
        queries: readonly PermissionQuery[],
      ): Promise<readonly PermissionDecision[]> =>
        queries.map(() => ({ effect: "deny" as const, reason: "not authorized" })),
    };

    const manager = createManager({ permissionBackend: backend });

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["exec"] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PERMISSION");
    expect(result.error.message).toContain("Escalation denied");
    expect(result.error.message).toContain("not authorized");
  });

  // -------------------------------------------------------------------------
  // 3. Fail-closed — backend throws
  // -------------------------------------------------------------------------

  test("fail-closed on backend error", async () => {
    const backend: PermissionBackend = {
      check: async (_query: PermissionQuery): Promise<PermissionDecision> => {
        throw new Error("permission service unavailable");
      },
      checkBatch: async (
        _queries: readonly PermissionQuery[],
      ): Promise<readonly PermissionDecision[]> => {
        throw new Error("permission service unavailable");
      },
    };

    const manager = createManager({ permissionBackend: backend });

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("fail-closed");
    expect(result.error.message).toContain("permission service unavailable");
    expect(result.error.retryable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Uses batch check when available
  // -------------------------------------------------------------------------

  test("uses batch check when available", async () => {
    let batchCallCount = 0;
    let individualCallCount = 0;

    const backend: PermissionBackend = {
      check: async (_query: PermissionQuery): Promise<PermissionDecision> => {
        individualCallCount++;
        return { effect: "allow" };
      },
      checkBatch: async (
        queries: readonly PermissionQuery[],
      ): Promise<readonly PermissionDecision[]> => {
        batchCallCount++;
        return queries.map(() => ({ effect: "allow" as const }));
      },
    };

    const manager = createManager({ permissionBackend: backend });

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file", "write_file"] },
    });

    expect(result.ok).toBe(true);
    expect(batchCallCount).toBe(1);
    expect(individualCallCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Falls back to sequential check when checkBatch is undefined
  // -------------------------------------------------------------------------

  test("falls back to sequential check when checkBatch is undefined", async () => {
    const checkedQueries: PermissionQuery[] = [];

    const backend: PermissionBackend = {
      check: async (query: PermissionQuery): Promise<PermissionDecision> => {
        checkedQueries.push(query);
        return { effect: "allow" };
      },
      // No checkBatch — omitted intentionally to force sequential fallback
    };

    const manager = createManager({ permissionBackend: backend });

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file", "write_file"] },
    });

    expect(result.ok).toBe(true);
    // Two permissions × one default resource = 2 individual check calls
    expect(checkedQueries.length).toBe(2);
    expect(checkedQueries.every((q) => q.principal === "agent:agent-1")).toBe(true);
    // Verifies checkBatch was not invoked (backend has no such method)
    expect((backend as { checkBatch?: unknown }).checkBatch).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. Deny on attenuate path when delegatee-as-grantor lacks permission
  // -------------------------------------------------------------------------

  test("denies attenuate when grantor lacks permission", async () => {
    // Root grant: agent-1 → agent-2 with read_file + write_file
    // agent-2 tries to sub-delegate write_file, but backend says agent-2 lacks it
    let _callCount = 0;

    const backend: PermissionBackend = {
      check: async (_query: PermissionQuery): Promise<PermissionDecision> => {
        _callCount++;
        return { effect: "deny", reason: "write_file not held by agent-2" };
      },
      checkBatch: async (
        queries: readonly PermissionQuery[],
      ): Promise<readonly PermissionDecision[]> => {
        _callCount += queries.length;
        return queries.map(() => ({
          effect: "deny" as const,
          reason: "write_file not held by agent-2",
        }));
      },
    };

    // First, create the manager WITHOUT the permission backend so the root
    // grant from agent-1 succeeds unconditionally
    const rootManager = createManager();
    const rootResult = await rootManager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file", "write_file"] },
    });
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;

    // Now create a manager WITH the escalation-checking backend and pre-seed
    // the grant store by constructing a manager that shares the same grant
    // We test attenuate via a fresh manager that has the parent grant in store
    const managerWithBackend = createDelegationManager({
      config: DEFAULT_CONFIG,
      permissionBackend: backend,
    });
    cleanups.push(managerWithBackend.dispose);

    // Create the root grant via this manager (backend allows agent-1 to hold all perms here?
    // No — we need backend to DENY only for agent-2. Use a backend that checks the principal.
    const smartBackend: PermissionBackend = {
      check: async (query: PermissionQuery): Promise<PermissionDecision> => {
        if (query.principal === "agent:agent-2") {
          return { effect: "deny", reason: "write_file not held by agent-2" };
        }
        return { effect: "allow" };
      },
      checkBatch: async (
        queries: readonly PermissionQuery[],
      ): Promise<readonly PermissionDecision[]> =>
        queries.map((q) =>
          q.principal === "agent:agent-2"
            ? { effect: "deny" as const, reason: "write_file not held by agent-2" }
            : { effect: "allow" as const },
        ),
    };

    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      permissionBackend: smartBackend,
    });
    cleanups.push(manager.dispose);

    // Root grant (agent-1 → agent-2) should succeed because agent-1 is allowed
    const parentResult = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file", "write_file"] },
    });
    expect(parentResult.ok).toBe(true);
    if (!parentResult.ok) return;

    // Attenuation from agent-2 → agent-3 should fail (agent-2 is denied)
    const attenuateResult = await manager.attenuate(parentResult.value.id, agentId("agent-3"), {
      permissions: { allow: ["write_file"] },
    });

    expect(attenuateResult.ok).toBe(false);
    if (attenuateResult.ok) return;
    expect(attenuateResult.error.code).toBe("PERMISSION");
    expect(attenuateResult.error.message).toContain("Escalation denied");
    expect(attenuateResult.error.message).toContain("write_file not held by agent-2");
  });
});
