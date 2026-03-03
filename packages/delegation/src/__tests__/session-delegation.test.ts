/**
 * Session-scoped delegation lifecycle tests.
 *
 * Verifies that DelegationManager correctly enforces session-scoped grant
 * verification when `getActiveSessions` is provided and a grant carries a
 * `scope.sessionId`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DelegationGrant } from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

describe("session-scoped delegation", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
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

  test("creates grant with sessionId in scope", async () => {
    const manager = createManager();

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
      sessionId: "session-abc",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const grant: DelegationGrant = result.value;
    expect(grant.scope.sessionId).toBe("session-abc");
    expect(grant.issuerId).toBe(agentId("agent-1"));
    expect(grant.delegateeId).toBe(agentId("agent-2"));
  });

  test("verify succeeds when session is active", async () => {
    const activeSessionId = "session-active";
    const manager = createManager({
      getActiveSessions: () => new Set([activeSessionId]),
    });

    const grantResult = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
      sessionId: activeSessionId,
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const verifyResult = await manager.verify(grantResult.value.id, "read_file");
    expect(verifyResult.ok).toBe(true);
  });

  test("verify fails when session has expired", async () => {
    const expiredSessionId = "session-expired";
    const manager = createManager({
      // getActiveSessions does NOT include the grant's sessionId
      getActiveSessions: () => new Set(["session-other"]),
    });

    const grantResult = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
      sessionId: expiredSessionId,
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const verifyResult = await manager.verify(grantResult.value.id, "read_file");
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toBe("session_expired");
    }
  });

  test("verify succeeds without getActiveSessions even with sessionId", async () => {
    // No getActiveSessions provided — session check is skipped entirely
    const manager = createManager();

    const grantResult = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
      sessionId: "session-xyz",
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    // Without getActiveSessions, verify ignores sessionId and proceeds normally
    const verifyResult = await manager.verify(grantResult.value.id, "read_file");
    expect(verifyResult.ok).toBe(true);
  });

  test("revoke by iterating session-scoped grants", async () => {
    const sharedSessionId = "session-shared";
    const manager = createManager({
      getActiveSessions: () => new Set([sharedSessionId]),
    });

    const grant1Result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
      sessionId: sharedSessionId,
    });
    const grant2Result = await manager.grant(agentId("agent-1"), agentId("agent-3"), {
      permissions: { allow: ["write_file"] },
      sessionId: sharedSessionId,
    });

    expect(grant1Result.ok).toBe(true);
    expect(grant2Result.ok).toBe(true);

    // Both grants are listed and carry the shared sessionId
    const allGrants = manager.list();
    expect(allGrants).toHaveLength(2);
    expect(allGrants.every((g) => g.scope.sessionId === sharedSessionId)).toBe(true);

    if (!grant1Result.ok || !grant2Result.ok) return;

    // Revoke both grants individually
    const revoked1 = await manager.revoke(grant1Result.value.id);
    const revoked2 = await manager.revoke(grant2Result.value.id);

    expect(revoked1).toContain(grant1Result.value.id);
    expect(revoked2).toContain(grant2Result.value.id);

    // Store is now empty
    expect(manager.list()).toHaveLength(0);
  });
});
