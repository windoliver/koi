/**
 * Integration tests for the supervision reconciler.
 *
 * Uses real InMemoryRegistry, ProcessTree, and FakeClock to test
 * all three supervision strategies, escalation, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  ChildSpec,
  ProcessState,
  ReconcileContext,
  RegistryEntry,
  SupervisionConfig,
} from "@koi/core";
import { agentId } from "@koi/core";
import type { FakeClock, InMemoryRegistry, ProcessTree, SpawnChildFn } from "@koi/engine-reconcile";
import {
  createCascadingTermination,
  createFakeClock,
  createInMemoryRegistry,
  createProcessTree,
  createSupervisionReconciler,
} from "@koi/engine-reconcile";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  id: string,
  parentId?: string,
  phase: ProcessState = "created",
  generation = 0,
): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    priority: 10,
    metadata: {},
    registeredAt: Date.now(),
    ...(parentId !== undefined ? { parentId: agentId(parentId) } : {}),
  };
}

function supervisedManifest(
  supervisionConfig: SupervisionConfig,
  overrides?: Partial<AgentManifest>,
): AgentManifest {
  return {
    name: "supervisor",
    version: "1.0.0",
    model: { name: "test-model" },
    supervision: supervisionConfig,
    ...overrides,
  };
}

function makeChildSpec(name: string, restart: ChildSpec["restart"] = "permanent"): ChildSpec {
  return { name, restart };
}

/** Creates a spawnChild function that registers new agents with sequential IDs. */
function createMockSpawnChild(
  registry: InMemoryRegistry,
  prefix = "spawned",
): { readonly spawnChild: SpawnChildFn; readonly spawnedIds: AgentId[] } {
  let counter = 0; // let: incremented on each spawn
  const spawnedIds: AgentId[] = [];

  const spawnChild: SpawnChildFn = async (parentId, _childSpec, _manifest) => {
    counter += 1;
    const newId = agentId(`${prefix}-${counter}`);
    registry.register(makeEntry(newId, parentId, "created", 0));
    spawnedIds.push(newId);
    return newId;
  };

  return { spawnChild, spawnedIds };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SupervisionReconciler", () => {
  let registry: InMemoryRegistry;
  let tree: ProcessTree;
  let clock: FakeClock;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    tree = createProcessTree(registry);
    clock = createFakeClock(0);
  });

  afterEach(async () => {
    await tree[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  function makeContext(manifest: AgentManifest): ReconcileContext {
    return { registry, manifest };
  }

  // =========================================================================
  // one_for_one
  // =========================================================================

  describe("one_for_one", () => {
    test("child A dies → only A restarted, B/C untouched", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a"), makeChildSpec("b"), makeChildSpec("c")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      // Register supervisor and children
      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("child-b", "sup", "running", 0));
      registry.register(makeEntry("child-c", "sup", "running", 0));

      // Initialize the reconciler's child map by doing a first reconcile with all alive
      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Terminate child A
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      expect(result.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(1);

      // B and C should still be running
      expect(registry.lookup(agentId("child-b"))?.status.phase).toBe("running");
      expect(registry.lookup(agentId("child-c"))?.status.phase).toBe("running");
    });

    test("temporary child dies → not restarted", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a", "temporary")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Terminate child A
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(0);
    });

    test("transient child dies from error → restarted", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a", "transient")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Terminate child A with error reason
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(1);
    });

    test("transient child completes normally → not restarted", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a", "transient")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Terminate child A with completed reason (normal exit)
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "completed" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(0);
    });
  });

  // =========================================================================
  // one_for_all
  // =========================================================================

  describe("one_for_all", () => {
    test("child A dies → A, B, C all terminated then restarted in declaration order", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_all" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a"), makeChildSpec("b"), makeChildSpec("c")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("child-b", "sup", "running", 0));
      registry.register(makeEntry("child-c", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Terminate child A
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");

      // B and C should have been terminated (by the reconciler)
      expect(registry.lookup(agentId("child-b"))?.status.phase).toBe("terminated");
      expect(registry.lookup(agentId("child-c"))?.status.phase).toBe("terminated");

      // All 3 children should be restarted (spawned)
      expect(spawnedIds).toHaveLength(3);
    });

    test("concurrent A+B termination → single restart cycle", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_all" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a"), makeChildSpec("b")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("child-b", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Both terminate before reconcile runs
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });
      registry.transition(agentId("child-b"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");
      // Both restarted in one cycle
      expect(spawnedIds).toHaveLength(2);
    });
  });

  // =========================================================================
  // rest_for_one
  // =========================================================================

  describe("rest_for_one", () => {
    test("child B dies → B, C terminated and restarted; A untouched", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "rest_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a"), makeChildSpec("b"), makeChildSpec("c")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("child-b", "sup", "running", 0));
      registry.register(makeEntry("child-c", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Terminate child B
      registry.transition(agentId("child-b"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");

      // A should be untouched (still running)
      expect(registry.lookup(agentId("child-a"))?.status.phase).toBe("running");

      // C should have been terminated
      expect(registry.lookup(agentId("child-c"))?.status.phase).toBe("terminated");

      // B and C were restarted (2 spawns)
      expect(spawnedIds).toHaveLength(2);
    });

    test("first child dies → same as one_for_all", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "rest_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a"), makeChildSpec("b")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("child-b", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Terminate first child
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");

      // B should be terminated (rest_for_one includes everything after A)
      expect(registry.lookup(agentId("child-b"))?.status.phase).toBe("terminated");

      // Both restarted
      expect(spawnedIds).toHaveLength(2);
    });
  });

  // =========================================================================
  // Escalation
  // =========================================================================

  describe("escalation", () => {
    test("restart budget exceeded → supervisor terminates with escalated reason", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 2,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // First restart
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(spawnedIds).toHaveLength(1);

      // Second restart (new child from spawn)
      const newChild1 =
        spawnedIds[0] ??
        (() => {
          throw new Error("expected spawned child");
        })();
      registry.transition(newChild1, "terminated", 1, { kind: "error" });
      clock.advance(1_000);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(spawnedIds).toHaveLength(2);

      // Third attempt — budget exhausted (maxRestarts=2)
      const newChild2 =
        spawnedIds[1] ??
        (() => {
          throw new Error("expected spawned child");
        })();
      registry.transition(newChild2, "terminated", 1, { kind: "error" });
      clock.advance(1_000);

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("terminal");

      // Supervisor should be terminated
      const supEntry = registry.lookup(agentId("sup"));
      expect(supEntry?.status.phase).toBe("terminated");
      expect(supEntry?.status.reason?.kind).toBe("escalated");
    });

    test("escalation cascades (supervisor's parent restarts supervisor)", async () => {
      // Set up a two-level supervision tree
      const innerConfig: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 1,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("worker")],
      };

      const outerConfig: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("inner-sup")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      // Register outer supervisor
      registry.register(makeEntry("outer-sup", undefined, "running", 0));
      // Register inner supervisor as child of outer
      registry.register(makeEntry("inner-sup", "outer-sup", "running", 0));
      // Register worker as child of inner
      registry.register(makeEntry("worker", "inner-sup", "running", 0));

      const innerManifest = supervisedManifest(innerConfig, { name: "inner-sup" });
      const outerManifest = supervisedManifest(outerConfig, { name: "outer-sup" });

      // Initialize both reconcilers
      await reconciler.reconcile(agentId("inner-sup"), makeContext(innerManifest));
      await reconciler.reconcile(agentId("outer-sup"), makeContext(outerManifest));

      // Worker crashes — inner supervisor restarts it
      registry.transition(agentId("worker"), "terminated", 0, { kind: "error" });
      await reconciler.reconcile(agentId("inner-sup"), makeContext(innerManifest));
      expect(spawnedIds).toHaveLength(1);

      // Worker crashes again — inner supervisor's budget exhausted, escalates
      const respawnedWorker =
        spawnedIds[0] ??
        (() => {
          throw new Error("expected spawned child");
        })();
      registry.transition(respawnedWorker, "terminated", 1, { kind: "error" });
      clock.advance(1_000);
      const escalateResult = await reconciler.reconcile(
        agentId("inner-sup"),
        makeContext(innerManifest),
      );
      expect(escalateResult.kind).toBe("terminal");
      expect(registry.lookup(agentId("inner-sup"))?.status.phase).toBe("terminated");

      // Outer supervisor should detect inner-sup terminated and restart it
      const outerResult = await reconciler.reconcile(
        agentId("outer-sup"),
        makeContext(outerManifest),
      );
      expect(outerResult.kind).toBe("converged");
      // 1 worker restart from inner + 1 inner-sup restart from outer = 2 total
      expect(spawnedIds).toHaveLength(2);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    test("zero-child supervisor → converged", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));

      const result = await reconciler.reconcile(
        agentId("sup"),
        makeContext(supervisedManifest(config)),
      );
      expect(result.kind).toBe("converged");
    });

    test("all children temporary → converged after all terminate", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a", "temporary"), makeChildSpec("b", "temporary")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("child-b", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Both terminate
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });
      registry.transition(agentId("child-b"), "terminated", 0, { kind: "error" });

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(0);
    });

    test("unsupervised agent → converged immediately", async () => {
      const manifest: AgentManifest = {
        name: "plain-agent",
        version: "1.0.0",
        model: { name: "test-model" },
        // No supervision field
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("agent", undefined, "running", 0));

      const result = await reconciler.reconcile(agentId("agent"), makeContext(manifest));
      expect(result.kind).toBe("converged");
    });

    test("supervisor terminated mid-reconcile → converged", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "terminated", 0));

      const result = await reconciler.reconcile(
        agentId("sup"),
        makeContext(supervisedManifest(config)),
      );
      expect(result.kind).toBe("converged");
    });

    test("deregistered child treated as needing restart for permanent spec", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Deregister the child entirely
      registry.deregister(agentId("child-a"));

      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(1);
    });

    test("budget recovers after time window slides", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 2,
        maxRestartWindowMs: 10_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // First restart at t=0
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(spawnedIds).toHaveLength(1);

      // Second restart at t=1000
      clock.advance(1_000);
      const newChild1 =
        spawnedIds[0] ??
        (() => {
          throw new Error("expected spawned child");
        })();
      registry.transition(newChild1, "terminated", 1, { kind: "error" });
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(spawnedIds).toHaveLength(2);

      // Advance past the window (first restart at t=0 expires after t=10_000)
      clock.advance(10_000);

      // Third restart should succeed — budget recovered
      const newChild2 =
        spawnedIds[1] ??
        (() => {
          throw new Error("expected spawned child");
        })();
      registry.transition(newChild2, "terminated", 1, { kind: "error" });
      const result = await reconciler.reconcile(agentId("sup"), makeContext(manifest));
      expect(result.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(3);
    });
  });

  // =========================================================================
  // isSupervised
  // =========================================================================

  describe("isSupervised", () => {
    test("returns true for initialized supervised children", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a"), makeChildSpec("b")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("child-b", "sup", "running", 0));

      // Before initialization — not yet tracked
      expect(reconciler.isSupervised(agentId("child-a"))).toBe(false);

      // Initialize via reconcile
      await reconciler.reconcile(agentId("sup"), makeContext(supervisedManifest(config)));

      // After initialization — tracked
      expect(reconciler.isSupervised(agentId("child-a"))).toBe(true);
      expect(reconciler.isSupervised(agentId("child-b"))).toBe(true);
    });

    test("returns false for unsupervised agents", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));
      registry.register(makeEntry("unrelated", undefined, "running", 0));

      await reconciler.reconcile(agentId("sup"), makeContext(supervisedManifest(config)));

      // Supervisor itself is not "supervised" (it is a supervisor, not a supervised child)
      expect(reconciler.isSupervised(agentId("sup"))).toBe(false);
      // Unrelated agent is not supervised
      expect(reconciler.isSupervised(agentId("unrelated"))).toBe(false);
    });

    test("updates on restart: old ID removed, new ID added", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild, spawnedIds } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      expect(reconciler.isSupervised(agentId("child-a"))).toBe(true);

      // Terminate child A
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Old ID no longer supervised
      expect(reconciler.isSupervised(agentId("child-a"))).toBe(false);
      // New ID is supervised
      const newId =
        spawnedIds[0] ??
        (() => {
          throw new Error("expected spawned child");
        })();
      expect(reconciler.isSupervised(newId)).toBe(true);
    });

    test("cleared on escalation", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 0,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      expect(reconciler.isSupervised(agentId("child-a"))).toBe(true);

      // Terminate child — budget exhausted (maxRestarts=0), escalates
      registry.transition(agentId("child-a"), "terminated", 0, { kind: "error" });
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Child should no longer be tracked as supervised
      expect(reconciler.isSupervised(agentId("child-a"))).toBe(false);
    });

    test("cleared on dispose", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child-a", "sup", "running", 0));

      await reconciler.reconcile(agentId("sup"), makeContext(supervisedManifest(config)));
      expect(reconciler.isSupervised(agentId("child-a"))).toBe(true);

      await reconciler[Symbol.asyncDispose]();
      expect(reconciler.isSupervised(agentId("child-a"))).toBe(false);
    });

    test("metadata-based matching uses childSpecName from registry", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("alpha"), makeChildSpec("beta")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      registry.register(makeEntry("sup", undefined, "running", 0));

      // Register children with childSpecName metadata (out of spec order)
      registry.register({
        ...makeEntry("child-beta", "sup", "running", 0),
        metadata: { childSpecName: "beta" },
      });
      registry.register({
        ...makeEntry("child-alpha", "sup", "running", 0),
        metadata: { childSpecName: "alpha" },
      });

      const manifest = supervisedManifest(config);
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Both should be tracked as supervised
      expect(reconciler.isSupervised(agentId("child-alpha"))).toBe(true);
      expect(reconciler.isSupervised(agentId("child-beta"))).toBe(true);

      // Terminate alpha — only alpha should be restarted (one_for_one)
      registry.transition(agentId("child-alpha"), "terminated", 0, { kind: "error" });
      await reconciler.reconcile(agentId("sup"), makeContext(manifest));

      // Beta should still be running (metadata-based matching assigned correctly)
      expect(registry.lookup(agentId("child-beta"))?.status.phase).toBe("running");
    });
  });

  // =========================================================================
  // CascadingTermination integration
  // =========================================================================

  describe("CascadingTermination integration", () => {
    test("supervised child termination defers cascading to grandchildren", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("child")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      // Wire isSupervised into CascadingTermination
      const cascade = createCascadingTermination(registry, tree, reconciler.isSupervised);

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child", "sup", "running", 0));
      registry.register(makeEntry("grandchild", "child", "running", 0));

      // Initialize supervision
      await reconciler.reconcile(agentId("sup"), makeContext(supervisedManifest(config)));

      // Terminate supervised child — cascading should defer
      registry.transition(agentId("child"), "terminated", 0, { kind: "error" });

      // Grandchild should still be running (cascading deferred for supervised child)
      expect(registry.lookup(agentId("grandchild"))?.status.phase).toBe("running");

      await cascade[Symbol.asyncDispose]();
    });

    test("unsupervised agent termination cascades normally", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("child")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      // Wire isSupervised into CascadingTermination
      const cascade = createCascadingTermination(registry, tree, reconciler.isSupervised);

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child", "sup", "running", 0));
      registry.register(makeEntry("unrelated", undefined, "running", 0));
      registry.register(makeEntry("unrelated-child", "unrelated", "running", 0));

      // Initialize supervision — only "child" is supervised
      await reconciler.reconcile(agentId("sup"), makeContext(supervisedManifest(config)));

      // Terminate unrelated parent — should cascade normally
      registry.transition(agentId("unrelated"), "terminated", 0, { kind: "completed" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(registry.lookup(agentId("unrelated-child"))?.status.phase).toBe("terminated");

      await cascade[Symbol.asyncDispose]();
    });

    test("supervisor termination cascades to all descendants", async () => {
      const config: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("child")],
      };

      const { spawnChild } = createMockSpawnChild(registry);
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
        clock,
      });

      const cascade = createCascadingTermination(registry, tree, reconciler.isSupervised);

      registry.register(makeEntry("sup", undefined, "running", 0));
      registry.register(makeEntry("child", "sup", "running", 0));
      registry.register(makeEntry("grandchild", "child", "running", 0));

      await reconciler.reconcile(agentId("sup"), makeContext(supervisedManifest(config)));

      // Terminate the supervisor itself — NOT a supervised child, so cascading proceeds
      registry.transition(agentId("sup"), "terminated", 0, { kind: "completed" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // All descendants should be cascade-terminated
      expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");
      expect(registry.lookup(agentId("grandchild"))?.status.phase).toBe("terminated");

      await cascade[Symbol.asyncDispose]();
    });
  });
});
