/**
 * Tests for SpawnLedger cap enforcement in createAgentSpawnFn (Issue #1996).
 *
 * Two acquisition paths:
 *   - No signal / no acquireOrWait → acquire() → immediate PERMISSION on capacity
 *   - Signal + acquireOrWait present → acquireOrWait(signal) → backpressure; INTERNAL on cancel
 *
 * slotPreAcquired=true is passed to spawnChildAgent so the terminated-event release
 * balances the slot acquired here.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, SpawnLedger, SubsystemToken, Tool } from "@koi/core";
import { agentId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { createAgentSpawnFn } from "../create-agent-spawn-fn.js";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_MANIFEST: AgentManifest = {
  name: "parent",
  version: "0.1.0",
  model: { name: "test-model" },
};

function mockTool(name: string): Tool {
  return {
    descriptor: { name, description: `Mock tool ${name}`, inputSchema: { type: "object" } },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async () => ({ result: name }),
  };
}

function mockParentAgent(): Agent {
  const toolMap = new Map<string, Tool>([["tool:Read", mockTool("Read")]]);
  return {
    pid: { id: agentId("parent-001"), name: "parent", type: "copilot", depth: 0 },
    manifest: BASE_MANIFEST,
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      if (prefix === "tool:") return toolMap as unknown as ReadonlyMap<SubsystemToken<T>, T>;
      return new Map();
    },
    components: () => toolMap as ReadonlyMap<string, unknown>,
  };
}

function makeSpawnFn(ledger: SpawnLedger) {
  const resolver = {
    resolve: () => ({
      ok: true as const,
      value: {
        name: "child-agent",
        description: "test child",
        manifest: {
          name: "child-agent",
          version: "0.1.0",
          model: { name: "test-model" },
        },
      },
    }),
    list: () => [],
  };

  const mockAdapter = {
    engineId: "test",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => {
      throw new Error("not used");
    },
  } as unknown as Parameters<typeof createAgentSpawnFn>[0]["adapter"];

  return createAgentSpawnFn({
    resolver,
    base: {
      parentAgent: mockParentAgent(),
      spawnLedger: ledger,
      spawnPolicy: {
        maxTotalProcesses: 10,
        maxDepth: 5,
        maxFanOut: 5,
      },
    },
    adapter: mockAdapter,
    manifestTemplate: BASE_MANIFEST,
  });
}

// ---------------------------------------------------------------------------
// No-signal path: immediate acquire() → PERMISSION on full ledger
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — no-signal path (Issue #1996)", () => {
  test("rejects immediately with PERMISSION when ledger is at capacity (no signal)", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "should be rejected immediately",
      // no signal → falls back to acquire() → immediate rejection
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("concurrent");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("does not consume a slot when rejecting at capacity (no signal)", async () => {
    const ledger = createInMemorySpawnLedger(2);
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(2);

    const spawnFn = makeSpawnFn(ledger);
    await spawnFn({ agentName: "child-agent", description: "rejected" });

    expect(ledger.activeCount()).toBe(2);
  });

  test("calls acquire() via no-signal path when acquireOrWait would be bypassed", async () => {
    let acquireCallCount = 0;
    const realLedger = createInMemorySpawnLedger(5);
    // Strip acquireOrWait so the fallback acquire() path is exercised
    const spyLedger: SpawnLedger = {
      acquire: () => {
        acquireCallCount++;
        return realLedger.acquire();
      },
      release: () => realLedger.release(),
      activeCount: () => realLedger.activeCount(),
      capacity: () => realLedger.capacity(),
    };

    const spawnFn = makeSpawnFn(spyLedger);
    await spawnFn({ agentName: "child-agent", description: "probe" });

    expect(acquireCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Signal path: acquireOrWait(signal) → backpressure + cancellation semantics
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — signal/acquireOrWait path (Issue #1996)", () => {
  test("uses acquireOrWait when signal and acquireOrWait are both available", async () => {
    let acquireOrWaitCallCount = 0;
    const realLedger = createInMemorySpawnLedger(5);
    const spyLedger: SpawnLedger = {
      acquire: () => realLedger.acquire(),
      release: () => realLedger.release(),
      activeCount: () => realLedger.activeCount(),
      capacity: () => realLedger.capacity(),
      acquireOrWait: (signal) => {
        acquireOrWaitCallCount++;
        return realLedger.acquireOrWait!(signal);
      },
    };

    const spawnFn = makeSpawnFn(spyLedger);
    await spawnFn({
      agentName: "child-agent",
      description: "probe acquireOrWait",
      signal: AbortSignal.timeout(1000),
    });

    expect(acquireOrWaitCallCount).toBe(1);
  });

  test("returns INTERNAL (not retryable) when abort signal fires before slot acquired", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot so acquireOrWait blocks

    const spawnFn = makeSpawnFn(ledger);
    // Already-aborted signal → pre-acquire abort check fires immediately
    const abortedSignal = AbortSignal.abort();

    const result = await spawnFn({
      agentName: "child-agent",
      description: "cancelled spawn",
      signal: abortedSignal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("allows spawn when ledger has capacity (with signal)", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "proceeds past the ledger gate",
      signal: AbortSignal.timeout(1000),
    });

    // Not a capacity error. May fail at engine level (no real engine) — expected.
    if (!result.ok) {
      expect(result.error.code).not.toBe("PERMISSION");
      expect(result.error.message).not.toMatch(/concurrent|capacity|slot/i);
    }
  });

  test("releases slot exactly once after spawn fails at engine level", async () => {
    let releaseCallCount = 0;
    const realLedger = createInMemorySpawnLedger(5);
    const spyLedger: SpawnLedger = {
      acquire: () => realLedger.acquire(),
      release: () => {
        releaseCallCount++;
        return realLedger.release();
      },
      activeCount: () => realLedger.activeCount(),
      capacity: () => realLedger.capacity(),
      // No acquireOrWait — use acquire() path so we control the count precisely
    };

    const spawnFn = makeSpawnFn(spyLedger);
    await spawnFn({
      agentName: "child-agent",
      description: "probe slot release",
    });

    expect(releaseCallCount).toBe(1);
  });
});
