/**
 * Tests for SpawnLedger cap enforcement via spawnChildAgent (Issue #1996).
 *
 * Cap enforcement lives in spawnChildAgent, not createAgentSpawnFn:
 * - acquireOrWait absent + full ledger: acquire() returns false → RATE_LIMIT
 * - acquireOrWait present + signal + full ledger: bounded wait (backpressure)
 * - acquireOrWait present + already-aborted signal: INTERNAL (non-retryable)
 *
 * SpawnRequest.signal is required. The acquire() path (no backpressure) is reached
 * when the ledger does not implement acquireOrWait — regardless of whether a signal
 * is present.
 *
 * Direct spawnChildAgent-level ledger tests (RATE_LIMIT, acquireOrWait, slot release
 * on assembly failure) live in spawn-child.test.ts — this file covers the integration
 * path through createAgentSpawnFn (streaming + non-streaming delivery).
 */

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  ReportStore,
  SpawnLedger,
  SubsystemToken,
  Tool,
} from "@koi/core";
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

/**
 * Minimal ledger with no acquireOrWait — forces spawnChildAgent to use acquire()
 * (non-blocking fast-fail) regardless of whether a signal is present.
 */
function makeSimpleLedger(capacity: number): SpawnLedger {
  const inner = createInMemorySpawnLedger(capacity);
  return {
    acquire: () => inner.acquire(),
    release: () => inner.release(),
    activeCount: () => inner.activeCount(),
    capacity: () => inner.capacity(),
    // acquireOrWait intentionally absent — triggers acquire() fast-fail path
  };
}

const MOCK_REPORT_STORE: ReportStore = {
  put: async () => {},
  getBySession: async () => [],
};

function makeSpawnFn(ledger: SpawnLedger, reportStore?: ReportStore) {
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
    ...(reportStore !== undefined ? { reportStore } : {}),
  });
}

// ---------------------------------------------------------------------------
// acquire() path — fast-fail at capacity (no acquireOrWait on ledger)
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — acquire() path (no acquireOrWait) (Issue #1996)", () => {
  test("rejects with RATE_LIMIT when ledger is at capacity (acquire() returns false)", async () => {
    const ledger = makeSimpleLedger(1);
    ledger.acquire(); // fill the only slot
    const spawnFn = makeSpawnFn(ledger);

    // Even with a signal, no acquireOrWait → spawnChildAgent falls back to acquire()
    const result = await spawnFn({
      agentName: "child-agent",
      description: "ledger full, no acquireOrWait → fast-fail",
      signal: AbortSignal.timeout(2000),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("does not consume a slot on RATE_LIMIT rejection", async () => {
    const ledger = makeSimpleLedger(2);
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(2);

    const spawnFn = makeSpawnFn(ledger);
    await spawnFn({
      agentName: "child-agent",
      description: "rejected",
      signal: AbortSignal.timeout(2000),
    });

    // acquire() returned false — no slot was taken, count unchanged
    expect(ledger.activeCount()).toBe(2);
  });

  test("RATE_LIMIT is retryable — a freed slot could let the next attempt succeed", async () => {
    const ledger = makeSimpleLedger(1);
    ledger.acquire();
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "at-cap",
      signal: AbortSignal.timeout(2000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("allows spawn when ledger has capacity and releases slot after failure", async () => {
    const ledger = makeSimpleLedger(5);
    expect(ledger.activeCount()).toBe(0);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "proceeds past cap check, fails at engine level",
      signal: AbortSignal.timeout(2000),
    });

    // Not a RATE_LIMIT error. May fail at engine level — expected.
    if (!result.ok) {
      expect(result.error.code).not.toBe("RATE_LIMIT");
    }
    // Slot must be released after any failure — no self-poisoning
    expect(ledger.activeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Non-streaming path — structured error contract
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — non-streaming (on_demand) delivery path", () => {
  test("non-streaming path returns structured SpawnResult on ledger failure (not a thrown error)", async () => {
    const ledger = makeSimpleLedger(1);
    ledger.acquire();

    // on_demand delivery requires a reportStore — provide a complete stub so we
    // reach the non-streaming spawnChildAgent call (not the VALIDATION early-return).
    const spawnFn = makeSpawnFn(ledger, MOCK_REPORT_STORE);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "non-streaming ledger failure",
      signal: AbortSignal.timeout(2000),
      delivery: { kind: "on_demand" },
    });

    // Must be a structured SpawnResult (not a thrown exception)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
    // Slot was not consumed (acquire() returned false before any state change)
    expect(ledger.activeCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// acquireOrWait path — bounded-wait backpressure (acquireOrWait present)
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — acquireOrWait() backpressure path", () => {
  test("acquireOrWait is called, resolves true after slot release, and slot is released after failure", async () => {
    const realLedger = createInMemorySpawnLedger(1);
    realLedger.acquire(); // fill the only slot

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

    // acquireOrWait was invoked AND resolved true (slot acquired via backpressure)
    expect(acquireOrWaitCalled).toBe(true);
    expect(acquireOrWaitResolution).toBe(true);
    // Slot must be fully released after the spawn fails — no ledger self-poisoning
    expect(realLedger.activeCount()).toBe(0);
  });

  test("acquireOrWait fast-path: slot acquired and released after failure", async () => {
    const ledger = createInMemorySpawnLedger(5);
    expect(ledger.activeCount()).toBe(0);
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
    // Slot must be released after spawn fails at engine level — no accumulation
    expect(ledger.activeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cancellation semantics — INTERNAL vs RATE_LIMIT
// ---------------------------------------------------------------------------

describe("SpawnLedger cap check — cancellation semantics", () => {
  test("returns INTERNAL (not retryable) when signal is already aborted (acquireOrWait path)", async () => {
    // acquireOrWait with an already-aborted signal returns false immediately,
    // and spawnChildAgent classifies that as INTERNAL (cancellation), not RATE_LIMIT.
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

  test("RATE_LIMIT (no acquireOrWait, capacity full) vs INTERNAL (already-aborted) are distinct codes", async () => {
    // No acquireOrWait → RATE_LIMIT
    const simpleFull = makeSimpleLedger(1);
    simpleFull.acquire();
    const spawnFn = makeSpawnFn(simpleFull);

    const rateLimitResult = await spawnFn({
      agentName: "child-agent",
      description: "at-cap via acquire()",
      signal: AbortSignal.timeout(2000),
    });
    expect(rateLimitResult.ok).toBe(false);
    if (!rateLimitResult.ok) {
      expect(rateLimitResult.error.code).toBe("RATE_LIMIT");
      expect(rateLimitResult.error.retryable).toBe(true);
    }

    // Already-aborted signal + acquireOrWait → INTERNAL (cancellation)
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
