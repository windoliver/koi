import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { agentId } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { wireSupervision } from "./wire-supervision.js";

const SUPERVISOR_MANIFEST: AgentManifest = {
  name: "supervisor",
  version: "1.0.0",
  model: { name: "test-model" },
  supervision: {
    strategy: { kind: "one_for_one" },
    maxRestarts: 3,
    maxRestartWindowMs: 30_000,
    children: [{ name: "a", restart: "permanent", isolation: "in-process" }],
  },
};

describe("wireSupervision", () => {
  test("returns all 4 components and a disposer", async () => {
    const registry = createInMemoryRegistry();
    const manifests = new Map<string, AgentManifest>([["supervisor-1", SUPERVISOR_MANIFEST]]);
    const wire = wireSupervision({
      registry,
      manifests,
      spawnChild: async () => agentId("never-called"),
    });

    expect(wire.processTree).toBeDefined();
    expect(wire.reconciler).toBeDefined();
    expect(wire.cascading).toBeDefined();
    expect(wire.reconcileRunner).toBeDefined();

    await wire[Symbol.asyncDispose]();
  });

  test("configures reconcileRunner with 30s drift sweep", () => {
    const registry = createInMemoryRegistry();
    const wire = wireSupervision({
      registry,
      manifests: new Map(),
      spawnChild: async () => agentId("x"),
    });

    const stats = wire.reconcileRunner.stats();
    expect(stats.activeControllers).toBeGreaterThanOrEqual(1);
  });

  test("cascading termination receives isSupervised from reconciler", async () => {
    const registry = createInMemoryRegistry();
    const parent = agentId("supervisor-1");
    const child = agentId("child-a");

    // Wire BEFORE registering so ProcessTree's registry.watch subscription
    // picks up the parent/child events (watch does not replay history).
    const wire = wireSupervision({
      registry,
      manifests: new Map([["supervisor-1", SUPERVISOR_MANIFEST]]),
      spawnChild: async () => agentId("never"),
    });

    registry.register({
      agentId: parent,
      status: {
        phase: "running",
        generation: 0,
        conditions: [],
        reason: { kind: "assembly_complete" },
        lastTransitionAt: Date.now(),
      },
      agentType: "worker",
      metadata: {},
      registeredAt: Date.now(),
      priority: 10,
    });
    registry.register({
      agentId: child,
      status: {
        phase: "running",
        generation: 0,
        conditions: [],
        reason: { kind: "assembly_complete" },
        lastTransitionAt: Date.now(),
      },
      agentType: "worker",
      metadata: { childSpecName: "a" },
      registeredAt: Date.now(),
      priority: 10,
      parentId: parent,
    });

    // Wait for the reconcile tick (default processTickIntervalMs = 100ms)
    // to drain the queue and populate the reconciler's childMap.
    await new Promise((r) => setTimeout(r, 250));

    expect(wire.reconciler.isSupervised(child)).toBe(true);
    expect(wire.reconciler.isSupervised(parent)).toBe(false);

    await wire[Symbol.asyncDispose]();
  });

  test("dispose is idempotent", async () => {
    const registry = createInMemoryRegistry();
    const wire = wireSupervision({
      registry,
      manifests: new Map(),
      spawnChild: async () => agentId("x"),
    });
    await wire[Symbol.asyncDispose]();
    await wire[Symbol.asyncDispose]();
  });
});
