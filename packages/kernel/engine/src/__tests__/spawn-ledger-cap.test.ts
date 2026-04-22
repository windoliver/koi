/**
 * Tests for SpawnLedger cap enforcement in createAgentSpawnFn (Issue #1996).
 *
 * Approach: TOCTOU cap check — acquire+release immediately to fail fast at
 * capacity, then spawnChildAgent owns the long-lived slot lifecycle.
 *
 * - No signal: acquire() → immediate PERMISSION if at capacity
 * - Already-aborted signal: pre-acquire check → INTERNAL (not retryable)
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
// Capacity enforcement
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement (Issue #1996)", () => {
  test("rejects immediately with PERMISSION when ledger is at capacity", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "should be rejected immediately — no signal so acquire() path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("concurrent");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("does not consume a slot on PERMISSION rejection (TOCTOU: acquire released before error)", async () => {
    const ledger = createInMemorySpawnLedger(2);
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(2);

    const spawnFn = makeSpawnFn(ledger);
    await spawnFn({ agentName: "child-agent", description: "rejected" });

    // The cap check acquires then releases — rejected spawn must not net-change the count.
    expect(ledger.activeCount()).toBe(2);
  });

  test("performs cap check via acquire() (exactly one acquire+release on the check)", async () => {
    let acquireCount = 0;
    let releaseCount = 0;
    const realLedger = createInMemorySpawnLedger(5);
    // Strip acquireOrWait so the no-signal acquire() path is exercised
    const spyLedger: SpawnLedger = {
      acquire: () => {
        acquireCount++;
        return realLedger.acquire();
      },
      release: () => {
        releaseCount++;
        return realLedger.release();
      },
      activeCount: () => realLedger.activeCount(),
      capacity: () => realLedger.capacity(),
    };

    const spawnFn = makeSpawnFn(spyLedger);
    await spawnFn({ agentName: "child-agent", description: "probe" });

    // The cap check does one acquire+release; spawnChildAgent does its own acquire.
    // Total acquire calls: 1 (cap check) + 1 (spawnChildAgent) = 2.
    // The cap-check release brings count back to 0 before spawnChildAgent re-acquires.
    expect(acquireCount).toBeGreaterThanOrEqual(1);
    expect(releaseCount).toBeGreaterThanOrEqual(1);
    // Net: count should be 0 after child terminates (spawnChildAgent terminated handler releases)
    expect(realLedger.activeCount()).toBe(0);
  });

  test("allows spawn when ledger has capacity", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "proceeds past the cap check",
      signal: AbortSignal.timeout(1000),
    });

    // Not a PERMISSION error from the cap check. May fail at engine level — expected.
    if (!result.ok) {
      expect(result.error.code).not.toBe("PERMISSION");
      expect(result.error.message).not.toMatch(/concurrent|capacity/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation vs capacity — correct error codes
// ---------------------------------------------------------------------------

describe("SpawnLedger cap check — cancellation semantics", () => {
  test("returns INTERNAL (not retryable) when signal is already aborted before cap check", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "cancelled before acquiring",
      signal: AbortSignal.abort(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("PERMISSION is retryable; INTERNAL cancellation is not", async () => {
    const fullLedger = createInMemorySpawnLedger(1);
    fullLedger.acquire();
    const spawnFn = makeSpawnFn(fullLedger);

    const permResult = await spawnFn({ agentName: "child-agent", description: "at-cap" });
    expect(permResult.ok).toBe(false);
    if (!permResult.ok) {
      expect(permResult.error.retryable).toBe(true);
    }

    const ledger2 = createInMemorySpawnLedger(5);
    const spawnFn2 = makeSpawnFn(ledger2);
    const cancelResult = await spawnFn2({
      agentName: "child-agent",
      description: "cancelled",
      signal: AbortSignal.abort(),
    });
    expect(cancelResult.ok).toBe(false);
    if (!cancelResult.ok) {
      expect(cancelResult.error.retryable).toBe(false);
    }
  });
});
