/**
 * Unit tests for createTerminatedSweeper.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  AgentRegistry,
  ReconcileContext,
  RegistryEntry,
} from "@koi/core";
import { createFakeClock } from "./clock.js";
import { createInMemoryRegistry } from "./registry.js";
import { createTerminatedSweeper } from "./terminated-sweeper.js";

function makeEntry(id: string, phase: "running" | "terminated", at: number): RegistryEntry {
  return {
    agentId: id as AgentId,
    agentType: "test",
    metadata: {},
    parentId: undefined,
    priority: 0,
    registeredAt: at,
    status: {
      phase,
      generation: 0,
      conditions: [],
      reason: { kind: "initialized" },
      lastTransitionAt: at,
    },
    zoneId: undefined,
  } as unknown as RegistryEntry;
}

const MANIFEST: AgentManifest = {
  name: "test",
  version: "0.0.0",
  model: { name: "test" },
} as AgentManifest;

describe("createTerminatedSweeper", () => {
  test("converged for missing agent", async () => {
    const registry = createInMemoryRegistry();
    const clock = createFakeClock(1000);
    const sweeper = createTerminatedSweeper({ ttlMs: 1000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    const result = await sweeper.reconcile("missing" as AgentId, ctx);
    expect(result.kind).toBe("converged");
  });

  test("converged for running agent (no-op)", async () => {
    const registry = createInMemoryRegistry();
    const clock = createFakeClock(1000);
    registry.register(makeEntry("a", "running", 1000));

    const sweeper = createTerminatedSweeper({ ttlMs: 1000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    const result = await sweeper.reconcile("a" as AgentId, ctx);
    expect(result.kind).toBe("converged");
    // Still registered
    expect(registry.lookup("a" as AgentId)).toBeDefined();
  });

  test("recheck when terminated but TTL not yet elapsed", async () => {
    const registry = createInMemoryRegistry();
    const clock = createFakeClock(1000);
    registry.register(makeEntry("a", "terminated", 1000));

    const sweeper = createTerminatedSweeper({ ttlMs: 5000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    const result = await sweeper.reconcile("a" as AgentId, ctx);
    expect(result.kind).toBe("recheck");
    if (result.kind === "recheck") {
      expect(result.afterMs).toBeGreaterThan(0);
      expect(result.afterMs).toBeLessThanOrEqual(60_000);
    }
    // Still registered
    expect(registry.lookup("a" as AgentId)).toBeDefined();
  });

  test("deregisters terminated agent once TTL elapsed", async () => {
    const registry = createInMemoryRegistry();
    const clock = createFakeClock(1000);
    registry.register(makeEntry("a", "terminated", 1000));

    const sweeper = createTerminatedSweeper({ ttlMs: 1000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    // Before TTL
    let r = await sweeper.reconcile("a" as AgentId, ctx);
    expect(r.kind).toBe("recheck");

    // Advance past TTL
    clock.advance(1100);
    r = await sweeper.reconcile("a" as AgentId, ctx);
    expect(r.kind).toBe("converged");

    // Now gone
    expect(registry.lookup("a" as AgentId)).toBeUndefined();
  });

  test("recheck delay is capped at 60s even when ttlMs is huge", async () => {
    const registry = createInMemoryRegistry();
    const clock = createFakeClock(1000);
    registry.register(makeEntry("a", "terminated", 1000));

    const sweeper = createTerminatedSweeper({ ttlMs: 24 * 60 * 60 * 1000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    const result = await sweeper.reconcile("a" as AgentId, ctx);
    expect(result.kind).toBe("recheck");
    if (result.kind === "recheck") {
      expect(result.afterMs).toBeLessThanOrEqual(60_000);
    }
  });

  test("async deregister failure is backoff-gated", async () => {
    const base = createInMemoryRegistry();
    const clock = createFakeClock(5_000);
    base.register(makeEntry("a", "terminated", 1_000));

    const registry: AgentRegistry = {
      ...base,
      deregister: async (_id: AgentId): Promise<boolean> => {
        throw new Error("storage unavailable");
      },
    };

    const sweeper = createTerminatedSweeper({ ttlMs: 1_000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    const first = await sweeper.reconcile("a" as AgentId, ctx);
    expect(first.kind).toBe("recheck");
    if (first.kind === "recheck") {
      expect(first.afterMs).toBe(1_000);
    }

    // Let the async deregister rejection settle and schedule backoff.
    await Promise.resolve();

    const second = await sweeper.reconcile("a" as AgentId, ctx);
    expect(second.kind).toBe("recheck");
    if (second.kind === "recheck") {
      expect(second.afterMs).toBeGreaterThan(0);
      expect(second.afterMs).toBeLessThanOrEqual(60_000);
    }
  });

  test("hung async deregister expires lease and issues a fresh attempt", async () => {
    const base = createInMemoryRegistry();
    const clock = createFakeClock(5_000);
    base.register(makeEntry("a", "terminated", 1_000));
    let calls = 0;

    const registry: AgentRegistry = {
      ...base,
      deregister: async (_id: AgentId): Promise<boolean> => {
        calls += 1;
        return await new Promise<boolean>(() => {});
      },
    };

    const sweeper = createTerminatedSweeper({ ttlMs: 1_000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    const first = await sweeper.reconcile("a" as AgentId, ctx);
    expect(first.kind).toBe("recheck");
    expect(calls).toBe(1);

    const second = await sweeper.reconcile("a" as AgentId, ctx);
    expect(second.kind).toBe("recheck");
    expect(calls).toBe(1);

    // Timeout the hung request and let its handler schedule retry state.
    clock.advance(10_001);
    await Promise.resolve();

    let observedSecondAttempt = false;
    for (let i = 0; i < 12; i++) {
      const probe = await sweeper.reconcile("a" as AgentId, ctx);
      expect(probe.kind).toBe("recheck");
      if (calls >= 2) {
        observedSecondAttempt = true;
        break;
      }
      if (probe.kind === "recheck") {
        clock.advance(probe.afterMs);
      }
      await Promise.resolve();
    }

    expect(observedSecondAttempt).toBe(true);
  });

  test("deregister retry caps at max backoff interval", async () => {
    const base = createInMemoryRegistry();
    const clock = createFakeClock(5_000);
    base.register(makeEntry("a", "terminated", 1_000));
    const registry: AgentRegistry = {
      ...base,
      deregister: (_id: AgentId): boolean => false,
    };

    const sweeper = createTerminatedSweeper({ ttlMs: 1_000, clock });
    const ctx: ReconcileContext = { registry, manifest: MANIFEST };

    let sawCap = false;
    for (let i = 0; i < 12; i++) {
      const result = await sweeper.reconcile("a" as AgentId, ctx);
      if (result.kind === "converged") break;
      if (result.kind !== "retry" && result.kind !== "recheck") break;
      if (result.afterMs === 60_000) {
        sawCap = true;
        break;
      }
      clock.advance(result.afterMs);
    }

    expect(sawCap).toBe(true);
  });
});
