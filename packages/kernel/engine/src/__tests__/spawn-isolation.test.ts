/**
 * Concurrent spawn isolation tests — verifies that concurrent spawns
 * maintain isolated state and clean up correctly (#1424).
 */

import { describe, expect, test } from "bun:test";
import { getAgentContext, runWithAgentContext } from "@koi/execution-context";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";

// ---------------------------------------------------------------------------
// SpawnLedger isolation tests
// ---------------------------------------------------------------------------

describe("SpawnLedger concurrent isolation", () => {
  test("concurrent acquire/release tracks slots correctly", () => {
    const ledger = createInMemorySpawnLedger(3);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(false); // at capacity
    expect(ledger.activeCount()).toBe(3);

    ledger.release();
    expect(ledger.activeCount()).toBe(2);
    expect(ledger.acquire()).toBe(true); // slot freed
    expect(ledger.activeCount()).toBe(3);
  });

  test("release below zero is a no-op", () => {
    const ledger = createInMemorySpawnLedger(2);
    ledger.release(); // no active slots
    expect(ledger.activeCount()).toBe(0);
  });

  test("acquireOrWait resolves immediately when slot available", async () => {
    const ledger = createInMemorySpawnLedger(2);
    const controller = new AbortController();
    const result = await ledger.acquireOrWait?.(controller.signal);
    expect(result).toBe(true);
    expect(ledger.activeCount()).toBe(1);
  });

  test("acquireOrWait waits for release then acquires", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot

    const controller = new AbortController();
    let resolved = false;
    const waitPromise = ledger.acquireOrWait?.(controller.signal).then((r) => {
      resolved = true;
      return r;
    });

    // Not resolved yet — blocked
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    expect(ledger.activeCount()).toBe(1);

    // Release the slot — waiter should wake
    ledger.release();
    const result = await waitPromise;
    expect(result).toBe(true);
    expect(resolved).toBe(true);
    expect(ledger.activeCount()).toBe(1); // re-acquired by waiter
  });

  test("acquireOrWait respects abort signal", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot

    const controller = new AbortController();
    const waitPromise = ledger.acquireOrWait?.(controller.signal);

    // Abort before release
    controller.abort();
    const result = await waitPromise;
    expect(result).toBe(false);
    expect(ledger.activeCount()).toBe(1); // original slot still held
  });

  test("acquireOrWait with already-aborted signal returns false immediately", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire();

    const controller = new AbortController();
    controller.abort();
    const result = await ledger.acquireOrWait?.(controller.signal);
    expect(result).toBe(false);
  });

  test("multiple waiters are served in FIFO order", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill

    const order: string[] = [];
    const c1 = new AbortController();
    const c2 = new AbortController();

    const w1 = ledger.acquireOrWait?.(c1.signal).then(() => {
      order.push("w1");
      ledger.release();
    });
    const w2 = ledger.acquireOrWait?.(c2.signal).then(() => {
      order.push("w2");
      ledger.release();
    });

    // Release the initial slot — should wake w1 first
    ledger.release();
    await Promise.all([w1, w2]);

    expect(order).toEqual(["w1", "w2"]);
  });
});

// ---------------------------------------------------------------------------
// AgentExecutionContext concurrent isolation tests
// ---------------------------------------------------------------------------

describe("AgentExecutionContext concurrent isolation", () => {
  test("concurrent runs get isolated contexts", async () => {
    const results = new Map<string, string>();

    await Promise.all([
      runWithAgentContext({ agentId: "agent-a", sessionId: "s-a" }, async () => {
        await new Promise((r) => setTimeout(r, 15));
        const ctx = getAgentContext();
        results.set("a", ctx?.agentId ?? "missing");
      }),
      runWithAgentContext({ agentId: "agent-b", sessionId: "s-b" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        const ctx = getAgentContext();
        results.set("b", ctx?.agentId ?? "missing");
      }),
      runWithAgentContext({ agentId: "agent-c", sessionId: "s-c" }, async () => {
        const ctx = getAgentContext();
        results.set("c", ctx?.agentId ?? "missing");
      }),
    ]);

    // Each agent got its own context despite interleaved scheduling
    expect(results.get("a")).toBe("agent-a");
    expect(results.get("b")).toBe("agent-b");
    expect(results.get("c")).toBe("agent-c");
  });

  test("parent context is not visible to child after nesting", () => {
    const outer = { agentId: "parent", sessionId: "s-parent" };
    const inner = { agentId: "child", sessionId: "s-child", parentAgentId: "parent" };

    runWithAgentContext(outer, () => {
      expect(getAgentContext()?.agentId).toBe("parent");

      runWithAgentContext(inner, () => {
        // Inner context replaces outer
        expect(getAgentContext()?.agentId).toBe("child");
        expect(getAgentContext()?.parentAgentId).toBe("parent");
      });

      // Outer restored
      expect(getAgentContext()?.agentId).toBe("parent");
    });
  });

  test("error in one context does not pollute another", async () => {
    const results: string[] = [];

    await Promise.allSettled([
      runWithAgentContext({ agentId: "ok-agent", sessionId: "s-ok" }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getAgentContext()?.agentId ?? "missing");
      }),
      runWithAgentContext({ agentId: "fail-agent", sessionId: "s-fail" }, async () => {
        throw new Error("intentional failure");
      }),
    ]);

    // The successful agent got its correct context despite the sibling failure
    expect(results).toEqual(["ok-agent"]);
  });
});
