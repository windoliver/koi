/**
 * Tests for onGrant/onRevoke hooks in CreateDelegationManagerParams.
 *
 * Verifies:
 * - onGrant fires after successful grant
 * - Grant is rolled back when onGrant throws (sync and async)
 * - onRevoke fires after successful revocation
 * - Revocation proceeds when onRevoke throws (best-effort)
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId } from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

describe("onGrant/onRevoke hooks", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      fn();
    }
    cleanups.length = 0;
  });

  test("calls onGrant after successful grant", async () => {
    const received: DelegationGrant[] = [];
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onGrant: (grant) => {
        received.push(grant);
      },
    });
    cleanups.push(manager.dispose);

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(result.value.id);
  });

  test("rolls back grant when onGrant throws (sync)", async () => {
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onGrant: () => {
        throw new Error("hook failure");
      },
    });
    cleanups.push(manager.dispose);

    await expect(
      manager.grant(agentId("agent-1"), agentId("agent-2"), {
        permissions: { allow: ["read_file"] },
      }),
    ).rejects.toThrow("onGrant hook failed");

    // Grant should be rolled back — not in store
    expect(manager.list()).toHaveLength(0);
  });

  test("rolls back grant when onGrant rejects (async)", async () => {
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onGrant: async () => {
        throw new Error("async hook failure");
      },
    });
    cleanups.push(manager.dispose);

    await expect(
      manager.grant(agentId("agent-1"), agentId("agent-2"), {
        permissions: { allow: ["read_file"] },
      }),
    ).rejects.toThrow("onGrant hook failed");

    expect(manager.list()).toHaveLength(0);
  });

  test("rolls back attenuated grant when onGrant throws", async () => {
    let callCount = 0;
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onGrant: () => {
        callCount++;
        // Let root grant succeed, fail on attenuated grant
        if (callCount > 1) {
          throw new Error("attenuate hook failure");
        }
      },
    });
    cleanups.push(manager.dispose);

    const root = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file", "write_file"] },
    });
    expect(root.ok).toBe(true);
    if (!root.ok) return;

    await expect(
      manager.attenuate(root.value.id, agentId("agent-3"), {
        permissions: { allow: ["read_file"] },
      }),
    ).rejects.toThrow("onGrant hook failed");

    // Root grant still exists, attenuated grant rolled back
    expect(manager.list()).toHaveLength(1);
  });

  test("calls onRevoke after successful revocation", async () => {
    const revokeArgs: Array<{ readonly id: DelegationId; readonly cascade: boolean }> = [];
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onRevoke: (id, cascade) => {
        revokeArgs.push({ id, cascade });
      },
    });
    cleanups.push(manager.dispose);

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await manager.revoke(result.value.id, true);

    expect(revokeArgs).toHaveLength(1);
    expect(revokeArgs[0]?.id).toBe(result.value.id);
    expect(revokeArgs[0]?.cascade).toBe(true);
  });

  test("proceeds with local revoke when onRevoke throws", async () => {
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onRevoke: () => {
        throw new Error("revoke hook failure");
      },
    });
    cleanups.push(manager.dispose);

    const result = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should NOT throw — revocation is best-effort for hooks
    const revokedIds = await manager.revoke(result.value.id);
    expect(revokedIds).toContain(result.value.id);

    // Grant is revoked locally despite hook failure
    expect(manager.list()).toHaveLength(0);
  });
});
