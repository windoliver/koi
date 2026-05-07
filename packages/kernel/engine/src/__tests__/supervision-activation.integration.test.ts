/**
 * Integration test — wireSupervision + in-process SpawnChildFn adapter
 * exercised end-to-end against a real AgentRegistry + ReconcileRunner.
 *
 * Scope (3b-5a): verifies the composed supervision subsystem without
 * createKoi. The "production wiring" for 3b-5a is: callers import
 * wireSupervision, pre-register the supervisor agent in their registry,
 * build a manifests map, and invoke. This test is the canonical example
 * of that caller pattern.
 */

import { describe, expect, test } from "bun:test";
import type { AgentId, AgentManifest, ChildSpec, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { createInProcessSpawnChildFn } from "../in-process-spawn-child-fn.js";
import { wireSupervision } from "../wire-supervision.js";

// Default reconcile tick is 100ms; give the runner at least one full tick
// plus slack before asserting.
const RECONCILE_WAIT_MS = 300;

function registerRunning(
  registry: ReturnType<typeof createInMemoryRegistry>,
  id: AgentId,
  opts: { readonly parentId?: AgentId; readonly childSpecName?: string } = {},
): RegistryEntry {
  return registry.register({
    agentId: id,
    status: {
      phase: "running",
      generation: 0,
      conditions: [],
      reason: { kind: "assembly_complete" },
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: opts.childSpecName !== undefined ? { childSpecName: opts.childSpecName } : {},
    registeredAt: Date.now(),
    priority: 10,
    ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
  });
}

function crashChild(registry: ReturnType<typeof createInMemoryRegistry>, id: AgentId): void {
  const entry = registry.lookup(id);
  if (entry === undefined || entry instanceof Promise) {
    throw new Error(`expected sync entry for ${id}`);
  }
  const result = registry.transition(id, "terminated", entry.status.generation, {
    kind: "error",
  });
  if (result instanceof Promise || !result.ok) {
    throw new Error(`transition failed for ${id}`);
  }
}

function childrenByName(
  registry: ReturnType<typeof createInMemoryRegistry>,
  name: string,
): readonly RegistryEntry[] {
  const all = registry.list();
  if (all instanceof Promise) throw new Error("expected sync list");
  return all.filter((e) => e.metadata.childSpecName === name && e.status.phase !== "terminated");
}

const THREE_CHILDREN: readonly ChildSpec[] = [
  { name: "a", restart: "permanent", isolation: "in-process" },
  { name: "b", restart: "permanent", isolation: "in-process" },
  { name: "c", restart: "permanent", isolation: "in-process" },
];

function supervisorManifest(
  strategy: "one_for_one" | "one_for_all" | "rest_for_one",
): AgentManifest {
  return {
    name: "strategy-supervisor",
    version: "1.0.0",
    model: { name: "test-model" },
    supervision: {
      strategy: { kind: strategy },
      maxRestarts: 10,
      maxRestartWindowMs: 60_000,
      children: THREE_CHILDREN,
    },
  };
}

const STRICT_SUPERVISOR: AgentManifest = {
  name: "strict-supervisor",
  version: "1.0.0",
  model: { name: "test-model" },
  supervision: {
    strategy: { kind: "one_for_one" },
    // The initial "spawn from empty childMap" records one attempt per spec,
    // so maxRestarts=2 allows one observed restart (count goes 1→2) and the
    // second crash escalates (count already at 2 → exhausted).
    maxRestarts: 2,
    maxRestartWindowMs: 60_000,
    children: [{ name: "worker", restart: "permanent", isolation: "in-process" }],
  },
};

function setupWire(manifest: AgentManifest): {
  registry: ReturnType<typeof createInMemoryRegistry>;
  parent: AgentId;
  spawnCounts: Map<string, number>;
  wire: ReturnType<typeof wireSupervision>;
} {
  const registry = createInMemoryRegistry();
  const parent = agentId("supervisor-1");
  const spawnCounts = new Map<string, number>();

  const spawnChild = createInProcessSpawnChildFn({
    registry,
    spawn: async (parentId, childSpec) => {
      const count = (spawnCounts.get(childSpec.name) ?? 0) + 1;
      spawnCounts.set(childSpec.name, count);
      const id = agentId(`${childSpec.name}-${count}`);
      registerRunning(registry, id, {
        parentId,
        childSpecName: childSpec.name,
      });
      return id;
    },
  });

  const wire = wireSupervision({
    registry,
    manifests: new Map([[parent, manifest]]),
    spawnChild,
  });

  // Register the supervisor AFTER wiring so ProcessTree sees it
  registerRunning(registry, parent);

  return { registry, parent, spawnCounts, wire };
}

describe("wireSupervision integration (3b-5a)", () => {
  test("auto-activation: manifest with supervision spawns children on first reconcile", async () => {
    const { registry, spawnCounts, wire } = setupWire(supervisorManifest("one_for_one"));

    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    expect(spawnCounts.get("a")).toBe(1);
    expect(spawnCounts.get("b")).toBe(1);
    expect(spawnCounts.get("c")).toBe(1);

    // All three are registered as running
    expect(childrenByName(registry, "a").length).toBe(1);
    expect(childrenByName(registry, "b").length).toBe(1);
    expect(childrenByName(registry, "c").length).toBe(1);

    await wire[Symbol.asyncDispose]();
  });

  test("one_for_one restarts only the failed child", async () => {
    const { registry, spawnCounts, wire } = setupWire(supervisorManifest("one_for_one"));

    // Initial spawn
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    // Crash child "a"
    const aLive = childrenByName(registry, "a");
    expect(aLive.length).toBe(1);
    crashChild(registry, aLive[0]!.agentId);

    // Sweep re-enqueues the supervisor so the reconciler observes the
    // terminated child. Event-driven watch events only enqueue the crashed
    // child itself, not its parent.
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    expect(spawnCounts.get("a")).toBe(2); // initial + 1 restart
    expect(spawnCounts.get("b")).toBe(1); // untouched
    expect(spawnCounts.get("c")).toBe(1); // untouched

    await wire[Symbol.asyncDispose]();
  });

  test("one_for_all restarts all children when any child crashes", async () => {
    const { registry, spawnCounts, wire } = setupWire(supervisorManifest("one_for_all"));

    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const bLive = childrenByName(registry, "b");
    expect(bLive.length).toBe(1);
    crashChild(registry, bLive[0]!.agentId);

    // Sweep re-enqueues the supervisor so the reconciler observes the
    // terminated child.
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    // All three specs respawned (initial + 1 cycle)
    expect(spawnCounts.get("a")).toBeGreaterThanOrEqual(2);
    expect(spawnCounts.get("b")).toBeGreaterThanOrEqual(2);
    expect(spawnCounts.get("c")).toBeGreaterThanOrEqual(2);

    await wire[Symbol.asyncDispose]();
  });

  test("rest_for_one restarts the failed child and later siblings", async () => {
    const { registry, spawnCounts, wire } = setupWire(supervisorManifest("rest_for_one"));

    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const bLive = childrenByName(registry, "b");
    expect(bLive.length).toBe(1);
    crashChild(registry, bLive[0]!.agentId);

    // Sweep re-enqueues the supervisor so the reconciler observes the
    // terminated child.
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    expect(spawnCounts.get("a")).toBe(1); // declared before b — untouched
    expect(spawnCounts.get("b")).toBeGreaterThanOrEqual(2);
    expect(spawnCounts.get("c")).toBeGreaterThanOrEqual(2);

    await wire[Symbol.asyncDispose]();
  });

  test("restart-budget exhaustion terminates supervisor with escalated reason", async () => {
    const { registry, parent, wire } = setupWire(STRICT_SUPERVISOR);

    // Initial spawn
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    // Crash + sweep + wait + crash again + sweep + wait.
    // maxRestarts=1, so the 2nd crash escalates.
    const first = childrenByName(registry, "worker");
    expect(first.length).toBe(1);
    crashChild(registry, first[0]!.agentId);
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const second = childrenByName(registry, "worker");
    expect(second.length).toBe(1);
    crashChild(registry, second[0]!.agentId);
    wire.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, RECONCILE_WAIT_MS));

    const supervisorEntry = registry.lookup(parent);
    if (supervisorEntry === undefined || supervisorEntry instanceof Promise) {
      throw new Error("expected supervisor entry");
    }
    expect(supervisorEntry.status.phase).toBe("terminated");
    expect(supervisorEntry.status.reason?.kind).toBe("escalated");

    await wire[Symbol.asyncDispose]();
  });

  test("dispose is idempotent and cleans up watchers", async () => {
    const { wire } = setupWire(supervisorManifest("one_for_one"));
    await wire[Symbol.asyncDispose]();
    await wire[Symbol.asyncDispose]();
  });
});
