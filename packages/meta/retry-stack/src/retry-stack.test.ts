/**
 * Unit tests for the createRetryStack factory.
 */

import { describe, expect, test } from "bun:test";
import type { BacktrackReason, SessionContext } from "@koi/core";
import { createRetryStack } from "./retry-stack.js";

function makeReason(message: string): BacktrackReason {
  return { kind: "manual", message, timestamp: Date.now() };
}

const STUB_SESSION: SessionContext = {
  sessionId: "test-session-1",
  agentId: "test-agent",
} as SessionContext;

describe("createRetryStack", () => {
  test("returns 2 middleware without fs-rollback", () => {
    const bundle = createRetryStack({});
    expect(bundle.middleware).toHaveLength(2);
    expect(bundle.config.fsRollbackEnabled).toBe(false);
  });

  test("middleware priorities are preserved (semantic < guided)", () => {
    const bundle = createRetryStack({});
    const priorities = bundle.middleware.map((mw) => mw.priority ?? 0);

    // semantic-retry (420) → guided-retry (425)
    const second = priorities[1];
    expect(second).toBeDefined();
    expect(priorities[0]).toBeLessThan(second ?? 0);
  });

  test("exposes semanticRetry handle with getRecords and reset", () => {
    const bundle = createRetryStack({});
    expect(bundle.semanticRetry).toBeDefined();
    expect(bundle.semanticRetry.getRecords()).toEqual([]);
    expect(typeof bundle.semanticRetry.reset).toBe("function");
  });

  test("exposes guidedRetry handle with constraint management", () => {
    const bundle = createRetryStack({});
    expect(bundle.guidedRetry).toBeDefined();
    expect(bundle.guidedRetry.hasConstraint()).toBe(false);
    expect(typeof bundle.guidedRetry.clearConstraint).toBe("function");
  });

  test("fsRollback is undefined when not configured", () => {
    const bundle = createRetryStack({});
    expect(bundle.fsRollback).toBeUndefined();
  });

  test("reset() cascades to all L2 handles", async () => {
    const bundle = createRetryStack({});

    // Initialize session so per-session state exists
    for (const mw of bundle.middleware) {
      if (mw.onSessionStart) await mw.onSessionStart(STUB_SESSION);
    }

    // Set a constraint so we can verify clearConstraint is called
    bundle.guidedRetry.setConstraint({
      reason: makeReason("test constraint"),
      maxInjections: 1,
    });
    expect(bundle.guidedRetry.hasConstraint()).toBe(true);

    bundle.reset();
    expect(bundle.guidedRetry.hasConstraint()).toBe(false);
  });

  test("config metadata reflects preset and middleware count", () => {
    const bundle = createRetryStack({ preset: "light" });
    expect(bundle.config.preset).toBe("light");
    expect(bundle.config.middlewareCount).toBe(2);
    expect(bundle.config.fsRollbackEnabled).toBe(false);
  });

  test("returns 3 middleware with fs-rollback configured", async () => {
    const { createInMemorySnapshotChainStore } = await import("@koi/snapshot-chain-store");
    const { chainId: makeChainId } = await import("@koi/core");

    const store = createInMemorySnapshotChainStore<import("@koi/core").FileOpRecord>();
    const cid = makeChainId("test-chain");

    const bundle = createRetryStack({
      fsRollback: {
        store,
        chainId: cid,
        backend: {
          name: "mock-fs",
          read: () => ({ ok: true as const, value: { content: "", path: "test", size: 0 } }),
          write: () => ({ ok: true as const, value: { path: "test", bytesWritten: 0 } }),
          edit: () => ({ ok: true as const, value: { path: "test", hunksApplied: 0 } }),
          list: () => ({ ok: true as const, value: { entries: [], truncated: false } }),
          search: () => ({ ok: true as const, value: { matches: [], truncated: false } }),
        },
      },
    });
    expect(bundle.middleware).toHaveLength(3);
    expect(bundle.config.fsRollbackEnabled).toBe(true);
  });
});
