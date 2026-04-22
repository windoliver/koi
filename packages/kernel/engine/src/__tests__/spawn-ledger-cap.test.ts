/**
 * Tests for SpawnLedger cap enforcement via spawnChildAgent (Issue #1996).
 *
 * Cap enforcement lives in spawnChildAgent, not createAgentSpawnFn:
 * - No signal + full ledger: acquire() returns false → RATE_LIMIT (fast-fail)
 * - Signal present + full ledger: acquireOrWait(signal) → bounded wait (backpressure)
 * - Already-aborted signal: acquireOrWait returns false → INTERNAL (not retryable)
 *
 * Both the streaming path (runSpawnedAgent → spawnChildAgent) and the non-streaming
 * path (direct spawnChildAgent call) wrap thrown KoiRuntimeErrors into SpawnResult,
 * preserving the structured error contract.
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

interface MakeSpawnFnOptions {
  readonly reportStore?: Parameters<typeof createAgentSpawnFn>[0]["reportStore"];
}

function makeSpawnFn(ledger: SpawnLedger, opts: MakeSpawnFnOptions = {}) {
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
    ...(opts.reportStore !== undefined ? { reportStore: opts.reportStore } : {}),
  });
}

// ---------------------------------------------------------------------------
// Unsignaled spawn — fast-fail at capacity via spawnChildAgent.acquire()
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — unsignaled spawns (Issue #1996)", () => {
  test("rejects with RATE_LIMIT when ledger is at capacity and no signal provided", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot
    const spawnFn = makeSpawnFn(ledger);

    // No signal → spawnChildAgent uses acquire() (non-blocking) → false → RATE_LIMIT
    const result = await spawnFn({
      agentName: "child-agent",
      description: "should be rejected — ledger full, no signal to wait on",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("does not consume a slot on RATE_LIMIT rejection", async () => {
    const ledger = createInMemorySpawnLedger(2);
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(2);

    const spawnFn = makeSpawnFn(ledger);
    await spawnFn({ agentName: "child-agent", description: "rejected" });

    // acquire() returned false — no slot was taken, count unchanged
    expect(ledger.activeCount()).toBe(2);
  });

  test("RATE_LIMIT is retryable — a freed slot could let the next attempt succeed", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire();
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({ agentName: "child-agent", description: "at-cap" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("allows unsignaled spawn when ledger has capacity", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "proceeds past cap check, fails at engine level",
    });

    // Not a RATE_LIMIT error from the cap check. May fail at engine level — expected.
    if (!result.ok) {
      expect(result.error.code).not.toBe("RATE_LIMIT");
    }
  });
});

// ---------------------------------------------------------------------------
// Non-streaming path — structured error contract
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — non-streaming (on_demand) delivery path", () => {
  test("non-streaming path returns structured SpawnResult on ledger failure (not a thrown error)", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot

    // on_demand delivery requires a reportStore — provide a minimal mock so we
    // reach the non-streaming spawnChildAgent call (not the VALIDATION early-return).
    const mockReportStore = {
      put: async (_report: RunReport): Promise<void> => {
        // no-op
      },
    };

    const spawnFn = makeSpawnFn(ledger, { reportStore: mockReportStore });

    // No signal → acquire() fast-fail; on_demand delivery routes through the
    // non-streaming branch with its own catch-and-wrap for KoiRuntimeError.
    const result = await spawnFn({
      agentName: "child-agent",
      description: "non-streaming ledger failure",
      delivery: { kind: "on_demand" },
    });

    // Must be a structured SpawnResult (not a thrown exception)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Signaled spawn — bounded-wait backpressure via spawnChildAgent.acquireOrWait
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — signaled spawns (backpressure path)", () => {
  test("acquireOrWait is called and resolves true after a slot is released (backpressure)", async () => {
    const realLedger = createInMemorySpawnLedger(1);
    realLedger.acquire(); // fill the only slot

    // Spy on acquireOrWait to verify it was called AND resolved with true (acquired)
    let acquireOrWaitCalled = false;
    let acquireOrWaitResolution: boolean | undefined;

    const spyLedger: SpawnLedger = {
      acquire: () => realLedger.acquire(),
      release: () => realLedger.release(),
      activeCount: () => realLedger.activeCount(),
      capacity: () => realLedger.capacity(),
      acquireOrWait: async (signal: AbortSignal): Promise<boolean> => {
        acquireOrWaitCalled = true;
        const result = await (realLedger.acquireOrWait?.(signal) ?? Promise.resolve(false));
        acquireOrWaitResolution = result;
        return result;
      },
    };

    // Release the held slot after 50 ms so the waiter can acquire
    const releaseTimer = setTimeout(() => {
      realLedger.release();
    }, 50);

    const spawnFn = makeSpawnFn(spyLedger);
    await spawnFn({
      agentName: "child-agent",
      description: "waits for slot via acquireOrWait backpressure",
      signal: AbortSignal.timeout(2000),
    });

    clearTimeout(releaseTimer);

    // Key assertions: acquireOrWait was invoked AND it resolved true (slot acquired)
    expect(acquireOrWaitCalled).toBe(true);
    expect(acquireOrWaitResolution).toBe(true);
  });

  test("allows signaled spawn when ledger has capacity", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "acquires slot immediately via acquireOrWait fast-path",
      signal: AbortSignal.timeout(1000),
    });

    if (!result.ok) {
      expect(result.error.code).not.toBe("RATE_LIMIT");
      expect(result.error.message).not.toMatch(/concurrent|capacity/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation semantics — INTERNAL vs RATE_LIMIT
// ---------------------------------------------------------------------------

describe("SpawnLedger cap check — cancellation semantics", () => {
  test("returns INTERNAL (not retryable) when signal is already aborted", async () => {
    // acquireOrWait with an already-aborted signal returns false, and
    // spawnChildAgent classifies that as INTERNAL (cancellation), not RATE_LIMIT.
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

  test("RATE_LIMIT (no signal) vs INTERNAL (already-aborted signal) are distinct", async () => {
    const fullLedger = createInMemorySpawnLedger(1);
    fullLedger.acquire();
    const spawnFn = makeSpawnFn(fullLedger);

    // No signal → fast-fail RATE_LIMIT
    const rateLimitResult = await spawnFn({ agentName: "child-agent", description: "at-cap" });
    expect(rateLimitResult.ok).toBe(false);
    if (!rateLimitResult.ok) {
      expect(rateLimitResult.error.code).toBe("RATE_LIMIT");
      expect(rateLimitResult.error.retryable).toBe(true);
    }

    // Already-aborted signal → INTERNAL (cancellation, non-retryable)
    const ledger2 = createInMemorySpawnLedger(5);
    const spawnFn2 = makeSpawnFn(ledger2);
    const cancelResult = await spawnFn2({
      agentName: "child-agent",
      description: "cancelled",
      signal: AbortSignal.abort(),
    });
    expect(cancelResult.ok).toBe(false);
    if (!cancelResult.ok) {
      expect(cancelResult.error.code).toBe("INTERNAL");
      expect(cancelResult.error.retryable).toBe(false);
    }
  });
});
