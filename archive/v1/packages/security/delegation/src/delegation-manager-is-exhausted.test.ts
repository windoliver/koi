/**
 * Unit tests for DelegationManager.isExhausted().
 */

import { afterEach, describe, expect, test } from "bun:test";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager } from "./delegation-manager.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: {
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    failureThreshold: 2,
  },
} as const;

describe("DelegationManager.isExhausted", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      fn();
    }
    cleanups.length = 0;
  });

  function createManager(): ReturnType<typeof createDelegationManager> {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    return manager;
  }

  test("returns false for empty delegatee list", () => {
    const manager = createManager();
    expect(manager.isExhausted([])).toBe(false);
  });

  test("returns false when all circuits are closed", () => {
    const manager = createManager();
    const ids = [agentId("w1"), agentId("w2")];
    expect(manager.isExhausted(ids)).toBe(false);
  });

  test("returns false when only some circuits are open", () => {
    const manager = createManager();
    const ids = [agentId("w1"), agentId("w2")];

    // Open w1's circuit (2 failures = threshold)
    manager.recordFailure(agentId("w1"));
    manager.recordFailure(agentId("w1"));
    expect(manager.circuitState(agentId("w1"))).toBe("open");
    expect(manager.circuitState(agentId("w2"))).toBe("closed");

    expect(manager.isExhausted(ids)).toBe(false);
  });

  test("returns true when all circuits are open", () => {
    const manager = createManager();
    const ids = [agentId("w1"), agentId("w2")];

    // Open both circuits
    manager.recordFailure(agentId("w1"));
    manager.recordFailure(agentId("w1"));
    manager.recordFailure(agentId("w2"));
    manager.recordFailure(agentId("w2"));

    expect(manager.circuitState(agentId("w1"))).toBe("open");
    expect(manager.circuitState(agentId("w2"))).toBe("open");
    expect(manager.isExhausted(ids)).toBe(true);
  });

  test("reports exhausted for subset when all in subset are open", () => {
    const manager = createManager();
    const ids = [agentId("w1"), agentId("w2")];

    // Open both circuits
    manager.recordFailure(agentId("w1"));
    manager.recordFailure(agentId("w1"));
    manager.recordFailure(agentId("w2"));
    manager.recordFailure(agentId("w2"));
    expect(manager.isExhausted(ids)).toBe(true);

    // A single-element subset of open circuits is also exhausted
    expect(manager.isExhausted([agentId("w1")])).toBe(true);
  });

  test("works with a single delegatee", () => {
    const manager = createManager();

    expect(manager.isExhausted([agentId("w1")])).toBe(false);

    manager.recordFailure(agentId("w1"));
    manager.recordFailure(agentId("w1"));

    expect(manager.isExhausted([agentId("w1")])).toBe(true);
  });
});
