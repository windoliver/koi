/**
 * DelegationManager lifecycle unit tests.
 *
 * Tests grant creation, listing, revocation, cascading, agent death cleanup,
 * and event emission.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentRegistry,
  DelegationEvent,
  DelegationId,
  RegistryEvent,
} from "@koi/core";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager } from "./delegation-manager.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

// ---------------------------------------------------------------------------
// Mock AgentRegistry for lifecycle binding tests
// ---------------------------------------------------------------------------

function createMockAgentRegistry(): AgentRegistry & {
  readonly emit: (event: RegistryEvent) => void;
} {
  const listeners: Array<(event: RegistryEvent) => void> = [];

  return {
    register: () => {
      throw new Error("not implemented");
    },
    deregister: () => {
      throw new Error("not implemented");
    },
    lookup: () => {
      throw new Error("not implemented");
    },
    list: () => {
      throw new Error("not implemented");
    },
    transition: () => {
      throw new Error("not implemented");
    },
    watch: (listener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    emit: (event) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    [Symbol.asyncDispose]: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DelegationManager", () => {
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

  test("creates a grant and stores it internally", () => {
    const manager = createManager();
    const result = manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.issuerId).toBe("agent-1");
    expect(result.value.delegateeId).toBe("agent-2");
    expect(result.value.chainDepth).toBe(0);

    // Verify it's stored
    const grants = manager.list("agent-2");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.id).toBe(result.value.id);
  });

  test("lists all active grants for an agent", () => {
    const manager = createManager();

    manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });
    manager.grant("agent-1", "agent-2", { permissions: { allow: ["write_file"] } });
    manager.grant("agent-1", "agent-3", { permissions: { allow: ["read_file"] } });

    expect(manager.list("agent-2")).toHaveLength(2);
    expect(manager.list("agent-3")).toHaveLength(1);
    expect(manager.list("agent-4")).toHaveLength(0);
  });

  test("lists all grants when no agentId provided", () => {
    const manager = createManager();

    manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });
    manager.grant("agent-1", "agent-3", { permissions: { allow: ["write_file"] } });

    expect(manager.list()).toHaveLength(2);
  });

  test("revokes a grant and removes from store", async () => {
    const manager = createManager();

    const result = manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const revoked = await manager.revoke(result.value.id);
    expect(revoked).toContain(result.value.id);
    expect(manager.list("agent-2")).toHaveLength(0);
  });

  test("cascading revocation removes all descendants", async () => {
    const manager = createManager();

    // Create root grant
    const rootResult = manager.grant("agent-1", "agent-2", {
      permissions: { allow: ["read_file", "write_file"] },
    });
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;

    // Attenuate to create child
    const childResult = manager.attenuate(rootResult.value.id, "agent-3", {
      permissions: { allow: ["read_file"] },
    });
    expect(childResult.ok).toBe(true);
    if (!childResult.ok) return;

    // Revoke root with cascade
    const revoked = await manager.revoke(rootResult.value.id, true);
    expect(revoked).toHaveLength(2);
    expect(revoked).toContain(rootResult.value.id);
    expect(revoked).toContain(childResult.value.id);

    // Both removed from store
    expect(manager.list()).toHaveLength(0);
  });

  test("auto-revokes grants when agent terminates (via registry.watch)", async () => {
    const registry = createMockAgentRegistry();
    const manager = createManager({ registry });

    // Create grant FROM agent-1 TO agent-2
    const result = manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Simulate agent-1 termination
    registry.emit({
      kind: "transitioned",
      agentId: "agent-1" as AgentId,
      from: "running",
      to: "terminated",
      generation: 1,
      reason: { kind: "completed" },
    });

    // Grant should be revoked (after async processing)
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.list()).toHaveLength(0);
  });

  test("parent agent death cascades grant revocation to children", async () => {
    const registry = createMockAgentRegistry();
    const manager = createManager({ registry });

    // agent-1 grants to agent-2
    const rootResult = manager.grant("agent-1", "agent-2", {
      permissions: { allow: ["read_file", "write_file"] },
    });
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;

    // agent-2 attenuates to agent-3
    const childResult = manager.attenuate(rootResult.value.id, "agent-3", {
      permissions: { allow: ["read_file"] },
    });
    expect(childResult.ok).toBe(true);

    // agent-1 dies → all grants cascade-revoked
    registry.emit({
      kind: "transitioned",
      agentId: "agent-1" as AgentId,
      from: "running",
      to: "terminated",
      generation: 1,
      reason: { kind: "completed" },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.list()).toHaveLength(0);
  });

  test("deregistered agent triggers grant cleanup", async () => {
    const registry = createMockAgentRegistry();
    const manager = createManager({ registry });

    manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });

    registry.emit({ kind: "deregistered", agentId: "agent-1" as AgentId });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.list()).toHaveLength(0);
  });

  test("returns Result error for invalid grant params", () => {
    const manager = createManager();

    const result = manager.grant("", "agent-2", { permissions: { allow: ["read_file"] } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("verify returns denied for unknown grant", async () => {
    const manager = createManager();
    const result = await manager.verify("nonexistent" as DelegationId, "read_file");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_grant");
    }
  });

  test("verify succeeds for valid grant and matching tool", async () => {
    const manager = createManager();
    const grantResult = manager.grant("agent-1", "agent-2", {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const verifyResult = await manager.verify(grantResult.value.id, "read_file");
    expect(verifyResult.ok).toBe(true);
  });

  test("verify returns denied for tool outside scope", async () => {
    const manager = createManager();
    const grantResult = manager.grant("agent-1", "agent-2", {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const verifyResult = await manager.verify(grantResult.value.id, "exec");
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toBe("scope_exceeded");
    }
  });

  test("emits delegation:granted event on new grant", () => {
    const events: DelegationEvent[] = [];
    const manager = createManager({ onEvent: (e) => events.push(e) });

    const result = manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });
    expect(result.ok).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("delegation:granted");
  });

  test("emits delegation:revoked event on revocation", async () => {
    const events: DelegationEvent[] = [];
    const manager = createManager({ onEvent: (e) => events.push(e) });

    const result = manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await manager.revoke(result.value.id);

    const revokeEvents = events.filter((e) => e.kind === "delegation:revoked");
    expect(revokeEvents).toHaveLength(1);
  });

  test("dispose unsubscribes from AgentRegistry", () => {
    const registry = createMockAgentRegistry();
    const manager = createDelegationManager({ config: DEFAULT_CONFIG, registry });

    manager.grant("agent-1", "agent-2", { permissions: { allow: ["read_file"] } });
    manager.dispose();

    // After dispose, registry events should not trigger cleanup
    registry.emit({
      kind: "transitioned",
      agentId: "agent-1" as AgentId,
      from: "running",
      to: "terminated",
      generation: 1,
      reason: { kind: "completed" },
    });

    // Grant still listed because dispose unsubscribed
    expect(manager.list()).toHaveLength(1);
  });

  test("circuit breaker methods delegate correctly", () => {
    const manager = createManager();

    expect(manager.canDelegate("agent-1")).toBe(true);
    expect(manager.circuitState("agent-1")).toBe("closed");

    manager.recordSuccess("agent-1");
    expect(manager.circuitState("agent-1")).toBe("closed");
  });
});
