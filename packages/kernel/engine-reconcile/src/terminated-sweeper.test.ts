/**
 * Unit tests for createTerminatedSweeper.
 */

import { describe, expect, test } from "bun:test";
import type { AgentId, AgentManifest, ReconcileContext, RegistryEntry } from "@koi/core";
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
});
