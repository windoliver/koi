/**
 * Concurrency tests for DelegationManager.
 *
 * Verifies correct behavior under concurrent operations:
 * - Concurrent verify + revoke consistency
 * - Concurrent grant creation produces unique IDs
 * - Event listeners receive all events under concurrency
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DelegationEvent, DelegationId } from "@koi/core";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

describe("concurrency", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      fn();
    }
    cleanups.length = 0;
  });

  test("concurrent grant creation produces unique IDs", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const results = Array.from({ length: 50 }, () =>
      manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } }),
    );

    const ids = new Set<DelegationId>();
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        ids.add(result.value.id);
      }
    }

    expect(ids.size).toBe(50);
  });

  test("concurrent verify and revoke see consistent state", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    // Create a grant
    const grantResult = manager.grant("agent-1", "agent-2", {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const grantId = grantResult.value.id;

    // Run verify and revoke concurrently
    const [verifyResult, revokedIds] = await Promise.all([
      manager.verify(grantId, "read_file"),
      manager.revoke(grantId),
    ]);

    // Either verify succeeded (ran before revoke) or failed (ran after revoke)
    // Both outcomes are valid — the key is no crash or inconsistent state
    if (verifyResult.ok) {
      expect(verifyResult.grant.id).toBe(grantId);
    } else {
      // After revoke, verify should fail
      expect(verifyResult.ok).toBe(false);
    }

    expect(revokedIds).toContain(grantId);

    // After both operations, grant should be gone
    expect(manager.list()).toHaveLength(0);
  });

  test("event listeners receive all events under concurrent operations", async () => {
    const events: DelegationEvent[] = [];
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onEvent: (e) => events.push(e),
    });
    cleanups.push(manager.dispose);

    // Create 10 grants concurrently (sync operation, but creates events)
    const grantResults = Array.from({ length: 10 }, (_, i) =>
      manager.grant("agent-1", `agent-${String(i + 2)}`, { permissions: { allow: ["read_file"] } }),
    );

    // All should succeed
    for (const result of grantResults) {
      expect(result.ok).toBe(true);
    }

    // Should have 10 granted events
    const grantedEvents = events.filter((e) => e.kind === "delegation:granted");
    expect(grantedEvents).toHaveLength(10);

    // Revoke all concurrently
    const revokePromises = grantResults
      .filter((r) => r.ok)
      .map((r) => {
        if (r.ok) return manager.revoke(r.value.id);
        return Promise.resolve([] as readonly DelegationId[]);
      });

    await Promise.all(revokePromises);

    // Should have 10 revoked events
    const revokedEvents = events.filter((e) => e.kind === "delegation:revoked");
    expect(revokedEvents).toHaveLength(10);
  });
});
