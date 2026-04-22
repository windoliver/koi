/**
 * Tests for SpawnLedger cap enforcement in createAgentSpawnFn (Issue #1996).
 *
 * Approach: TOCTOU cap check for unsignaled spawns only.
 *   - No signal + full ledger: acquire()+release() → immediate RATE_LIMIT (fast-fail)
 *   - Signal present + full ledger: fall through to spawnChildAgent's acquireOrWait(signal)
 *     (bounded-wait backpressure — does NOT fail immediately)
 *   - Already-aborted signal: pre-acquire check → INTERNAL (not retryable)
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
// Unsignaled spawn — fast-fail at capacity
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — unsignaled spawns (Issue #1996)", () => {
  test("rejects immediately with RATE_LIMIT when ledger is at capacity (no signal)", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "should be rejected immediately — no signal so acquire() path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.message).toContain("concurrent");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("does not consume a slot on RATE_LIMIT rejection (TOCTOU: acquire released before error)", async () => {
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
    // No signal → TOCTOU path
    await spawnFn({ agentName: "child-agent", description: "probe" });

    // The cap check does one acquire+release; spawnChildAgent does its own acquire.
    expect(acquireCount).toBeGreaterThanOrEqual(1);
    expect(releaseCount).toBeGreaterThanOrEqual(1);
    expect(realLedger.activeCount()).toBe(0);
  });

  test("allows unsignaled spawn when ledger has capacity", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "proceeds past the cap check",
    });

    // Not a RATE_LIMIT error from the cap check. May fail at engine level — expected.
    if (!result.ok) {
      expect(result.error.code).not.toBe("RATE_LIMIT");
      expect(result.error.message).not.toMatch(/concurrent|capacity/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Signaled spawn — bounded-wait backpressure (no fast-fail)
// ---------------------------------------------------------------------------

describe("SpawnLedger cap enforcement — signaled spawns (backpressure path)", () => {
  test("does NOT reject immediately when signal present and ledger is full (uses acquireOrWait)", async () => {
    const ledger = createInMemorySpawnLedger(1);
    ledger.acquire(); // fill the only slot

    // Release the slot shortly after so acquireOrWait can succeed
    const controller = new AbortController();
    const releaseTimer = setTimeout(() => {
      ledger.release();
    }, 50);

    const spawnFn = makeSpawnFn(ledger);
    const result = await spawnFn({
      agentName: "child-agent",
      description: "should wait for slot via acquireOrWait, not fail immediately",
      signal: controller.signal,
    });

    clearTimeout(releaseTimer);

    // Must NOT be RATE_LIMIT — the signaled path uses acquireOrWait backpressure
    if (!result.ok) {
      expect(result.error.code).not.toBe("RATE_LIMIT");
    }
  });

  test("allows signaled spawn when ledger has capacity", async () => {
    const ledger = createInMemorySpawnLedger(5);
    const spawnFn = makeSpawnFn(ledger);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "proceeds past the cap check",
      signal: AbortSignal.timeout(1000),
    });

    // Not a RATE_LIMIT error from the cap check. May fail at engine level — expected.
    if (!result.ok) {
      expect(result.error.code).not.toBe("RATE_LIMIT");
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

  test("RATE_LIMIT is retryable; INTERNAL cancellation is not", async () => {
    const fullLedger = createInMemorySpawnLedger(1);
    fullLedger.acquire();
    const spawnFn = makeSpawnFn(fullLedger);

    // No signal → fast-fail with RATE_LIMIT
    const rateLimitResult = await spawnFn({ agentName: "child-agent", description: "at-cap" });
    expect(rateLimitResult.ok).toBe(false);
    if (!rateLimitResult.ok) {
      expect(rateLimitResult.error.code).toBe("RATE_LIMIT");
      expect(rateLimitResult.error.retryable).toBe(true);
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
      expect(cancelResult.error.code).toBe("INTERNAL");
      expect(cancelResult.error.retryable).toBe(false);
    }
  });
});
