/**
 * Tests for SpawnLedger cap enforcement in createAgentSpawnFn (Issue #1996).
 *
 * Verifies that the max-concurrent-agents cap is actually enforced:
 * - acquire() called before spawning
 * - reject with PERMISSION error when at capacity
 * - release() called when child completes or errors
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, SubsystemToken, Tool } from "@koi/core";
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

function makeSpawnFn(ledger: ReturnType<typeof createInMemorySpawnLedger>) {
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
// Tests
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement (Issue #1996)", () => {
  test("rejects spawn with PERMISSION error when ledger is at capacity", async () => {
    const ledger = createInMemorySpawnLedger(1);
    // Fill the only slot
    const acquired = ledger.acquire();
    expect(acquired).toBe(true);

    const spawnFn = makeSpawnFn(ledger);
    const result = await spawnFn({
      agentName: "child-agent",
      description: "this should be rejected — no slots available",
      signal: AbortSignal.timeout(1000),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("concurrent");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("does not consume a ledger slot when rejecting at capacity", async () => {
    const ledger = createInMemorySpawnLedger(2);
    // Fill both slots
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(2);

    const spawnFn = makeSpawnFn(ledger);
    await spawnFn({
      agentName: "child-agent",
      description: "rejected spawn",
      signal: AbortSignal.timeout(1000),
    });

    // Slot count must stay at 2 — rejected spawn must not leak or over-release
    expect(ledger.activeCount()).toBe(2);
  });

  test("allows spawn when ledger has capacity", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "this should proceed past the ledger gate",
      signal: AbortSignal.timeout(1000),
    });

    // Must not be a PERMISSION error from the ledger gate.
    // May fail for other reasons (no real engine) — that is expected in unit tests.
    if (!result.ok) {
      expect(result.error.code).not.toBe("PERMISSION");
      // Specifically must not mention capacity
      expect(result.error.message).not.toMatch(/concurrent|capacity|slot/i);
    }
  });

  test("calls acquire() exactly once per spawn attempt", async () => {
    let acquireCallCount = 0;
    const realLedger = createInMemorySpawnLedger(5);
    const spyLedger = {
      ...realLedger,
      acquire: () => {
        acquireCallCount++;
        return realLedger.acquire();
      },
    };

    const spawnFn = makeSpawnFn(spyLedger);
    await spawnFn({
      agentName: "child-agent",
      description: "probe spawn slot acquisition",
      signal: AbortSignal.timeout(1000),
    });

    expect(acquireCallCount).toBe(1);
  });

  test("releases slot after spawn fails at engine level", async () => {
    let releaseCallCount = 0;
    const realLedger = createInMemorySpawnLedger(5);
    const spyLedger = {
      ...realLedger,
      release: () => {
        releaseCallCount++;
        return realLedger.release();
      },
    };

    const spawnFn = makeSpawnFn(spyLedger);
    // Spawn will fail at engine level (no real engine), release must still fire
    await spawnFn({
      agentName: "child-agent",
      description: "probe spawn slot release",
      signal: AbortSignal.timeout(1000),
    });

    expect(releaseCallCount).toBe(1);
  });
});
