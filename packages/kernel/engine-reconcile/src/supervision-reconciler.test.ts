import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  AgentRegistry,
  ChildSpec,
  ReconcileContext,
  RegistryEntry,
} from "@koi/core";
import { agentId } from "@koi/core";
import { createFakeClock } from "./clock.js";
import { createProcessTree } from "./process-tree.js";
import { createInMemoryRegistry } from "./registry.js";
import { createSupervisionReconciler } from "./supervision-reconciler.js";

function createEntry(params: {
  readonly id: AgentId;
  readonly phase: "created" | "running" | "terminated";
  readonly parentId?: AgentId | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly generation?: number | undefined;
}): RegistryEntry {
  return {
    agentId: params.id,
    status: {
      phase: params.phase,
      generation: params.generation ?? 0,
      conditions: [],
      reason: params.phase === "terminated" ? { kind: "error" } : { kind: "assembly_complete" },
      lastTransitionAt: 1_000,
    },
    agentType: "worker",
    metadata: params.metadata ?? {},
    registeredAt: 1_000,
    priority: 10,
    ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
  };
}

const SUPERVISION_MANIFEST: AgentManifest = {
  name: "supervisor",
  version: "1.0.0",
  model: { name: "test-model" },
  supervision: {
    strategy: { kind: "rest_for_one" },
    maxRestarts: 1,
    maxRestartWindowMs: 60_000,
    children: [
      { name: "a", restart: "permanent" },
      { name: "b", restart: "permanent" },
    ],
  },
};

describe("createSupervisionReconciler", () => {
  test("rest_for_one rolls back restart budget when restart cycle fails", async () => {
    const registry = createInMemoryRegistry();
    const tree = createProcessTree(registry);
    const clock = createFakeClock(1_000);
    const supervisorId = agentId("supervisor");

    let spawnCounter = 0;
    const failBSpawn = true;

    try {
      registry.register(createEntry({ id: supervisorId, phase: "running" }));
      registry.register(
        createEntry({
          id: agentId("a-old"),
          phase: "terminated",
          parentId: supervisorId,
          metadata: { childSpecName: "a" },
        }),
      );
      registry.register(
        createEntry({
          id: agentId("b-old"),
          phase: "running",
          parentId: supervisorId,
          metadata: { childSpecName: "b" },
        }),
      );

      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        clock,
        spawnChild: async (
          parentId: AgentId,
          spec: ChildSpec,
          _manifest: AgentManifest,
        ): Promise<AgentId> => {
          if (spec.name === "b" && failBSpawn) {
            throw new Error("spawn b failed");
          }
          spawnCounter += 1;
          const replacementId = agentId(`${spec.name}-restart-${String(spawnCounter)}`);
          registry.register(
            createEntry({
              id: replacementId,
              phase: "created",
              parentId,
              metadata: { childSpecName: spec.name },
            }),
          );
          return replacementId;
        },
      });

      const ctx: ReconcileContext = {
        registry,
        manifest: SUPERVISION_MANIFEST,
      };

      const first = await reconciler.reconcile(supervisorId, ctx);
      expect(first.kind).toBe("retry");
      // First replacement is rolled back to terminated when later restart fails.
      expect(registry.lookup(agentId("a-restart-1"))?.status.phase).toBe("terminated");

      // Retry should escalate once budget is exhausted by persistent failure.
      const retryResult = await reconciler.reconcile(supervisorId, ctx);
      expect(retryResult.kind).toBe("terminal");
      expect(registry.lookup(supervisorId)?.status.phase).toBe("terminated");

      await reconciler[Symbol.asyncDispose]();
    } finally {
      await tree[Symbol.asyncDispose]();
      await registry[Symbol.asyncDispose]();
    }
  });

  test("rest_for_one keeps restarted child supervised when rollback termination is unconfirmed", async () => {
    const baseRegistry = createInMemoryRegistry();
    const tree = createProcessTree(baseRegistry);
    const clock = createFakeClock(1_000);
    const supervisorId = agentId("supervisor-rollback");
    const blockedChildId = agentId("a-restart-blocked");

    let spawnCounter = 0;

    const registry = {
      ...baseRegistry,
      transition: ((id, targetPhase, expectedGeneration, reason) => {
        if (id === blockedChildId && targetPhase === "terminated") {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: "forced conflict for rollback verification",
              retryable: true,
            },
          } as const;
        }
        return baseRegistry.transition(id, targetPhase, expectedGeneration, reason);
      }) satisfies typeof baseRegistry.transition,
    };

    try {
      registry.register(createEntry({ id: supervisorId, phase: "running" }));
      registry.register(
        createEntry({
          id: agentId("a-old"),
          phase: "terminated",
          parentId: supervisorId,
          metadata: { childSpecName: "a" },
        }),
      );
      registry.register(
        createEntry({
          id: agentId("b-old"),
          phase: "running",
          parentId: supervisorId,
          metadata: { childSpecName: "b" },
        }),
      );

      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        clock,
        spawnChild: async (
          parentId: AgentId,
          spec: ChildSpec,
          _manifest: AgentManifest,
        ): Promise<AgentId> => {
          if (spec.name === "b") {
            throw new Error("spawn b failed");
          }
          spawnCounter += 1;
          const replacementId = spawnCounter === 1 ? blockedChildId : agentId("a-fallback");
          registry.register(
            createEntry({
              id: replacementId,
              phase: "created",
              parentId,
              metadata: { childSpecName: spec.name },
            }),
          );
          return replacementId;
        },
      });

      const ctx: ReconcileContext = {
        registry,
        manifest: SUPERVISION_MANIFEST,
      };

      const result = await reconciler.reconcile(supervisorId, ctx);
      expect(result.kind).toBe("retry");
      expect(reconciler.isSupervised(blockedChildId)).toBe(true);

      await reconciler[Symbol.asyncDispose]();
    } finally {
      await tree[Symbol.asyncDispose]();
      await baseRegistry[Symbol.asyncDispose]();
    }
  });

  test("rest_for_one does not escalate from stale budget when rollback is unconfirmed", async () => {
    const baseRegistry = createInMemoryRegistry();
    const tree = createProcessTree(baseRegistry);
    const clock = createFakeClock(1_000);
    const supervisorId = agentId("supervisor-budget");
    const blockedChildId = agentId("a-restart-budget");

    let spawnCounter = 0;
    let hideBlockedChild = false;

    const registry = {
      ...baseRegistry,
      lookup: ((id) => {
        if (id === blockedChildId && hideBlockedChild) {
          return undefined;
        }
        return baseRegistry.lookup(id);
      }) satisfies typeof baseRegistry.lookup,
      transition: ((id, targetPhase, expectedGeneration, reason) => {
        if (id === blockedChildId && targetPhase === "terminated") {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: "forced rollback uncertainty",
              retryable: true,
            },
          } as const;
        }
        return baseRegistry.transition(id, targetPhase, expectedGeneration, reason);
      }) satisfies typeof baseRegistry.transition,
    };

    try {
      registry.register(createEntry({ id: supervisorId, phase: "running" }));
      registry.register(
        createEntry({
          id: agentId("a-old"),
          phase: "terminated",
          parentId: supervisorId,
          metadata: { childSpecName: "a" },
        }),
      );
      registry.register(
        createEntry({
          id: agentId("b-old"),
          phase: "running",
          parentId: supervisorId,
          metadata: { childSpecName: "b" },
        }),
      );

      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        clock,
        spawnChild: async (
          parentId: AgentId,
          spec: ChildSpec,
          _manifest: AgentManifest,
        ): Promise<AgentId> => {
          if (spec.name === "b") {
            throw new Error("spawn b failed");
          }
          spawnCounter += 1;
          const replacementId =
            spawnCounter === 1 ? blockedChildId : agentId(`a-restart-${String(spawnCounter)}`);
          registry.register(
            createEntry({
              id: replacementId,
              phase: "created",
              parentId,
              metadata: { childSpecName: spec.name },
            }),
          );
          return replacementId;
        },
      });

      const ctx: ReconcileContext = {
        registry,
        manifest: SUPERVISION_MANIFEST,
      };

      const first = await reconciler.reconcile(supervisorId, ctx);
      expect(first.kind).toBe("retry");

      // Simulate eventual-consistency visibility gap on the rolled-back child.
      hideBlockedChild = true;

      const second = await reconciler.reconcile(supervisorId, ctx);
      expect(second.kind).toBe("retry");
      expect(baseRegistry.lookup(supervisorId)?.status.phase).toBe("running");

      await reconciler[Symbol.asyncDispose]();
    } finally {
      await tree[Symbol.asyncDispose]();
      await baseRegistry[Symbol.asyncDispose]();
    }
  });

  test("rest_for_one treats rollback NOT_FOUND as already terminated", async () => {
    const baseRegistry = createInMemoryRegistry();
    const tree = createProcessTree(baseRegistry);
    const clock = createFakeClock(1_000);
    const supervisorId = agentId("supervisor-not-found");
    const blockedChildId = agentId("a-restart-not-found");

    let spawnCounter = 0;

    const registry = {
      ...baseRegistry,
      transition: ((id, targetPhase, expectedGeneration, reason) => {
        if (id === blockedChildId && targetPhase === "terminated") {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "child already removed",
              retryable: false,
            },
          } as const;
        }
        return baseRegistry.transition(id, targetPhase, expectedGeneration, reason);
      }) satisfies typeof baseRegistry.transition,
    };

    try {
      registry.register(createEntry({ id: supervisorId, phase: "running" }));
      registry.register(
        createEntry({
          id: agentId("a-old"),
          phase: "terminated",
          parentId: supervisorId,
          metadata: { childSpecName: "a" },
        }),
      );
      registry.register(
        createEntry({
          id: agentId("b-old"),
          phase: "running",
          parentId: supervisorId,
          metadata: { childSpecName: "b" },
        }),
      );

      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        clock,
        spawnChild: async (
          parentId: AgentId,
          spec: ChildSpec,
          _manifest: AgentManifest,
        ): Promise<AgentId> => {
          if (spec.name === "b") {
            throw new Error("spawn b failed");
          }
          spawnCounter += 1;
          const replacementId = spawnCounter === 1 ? blockedChildId : agentId("a-fallback");
          registry.register(
            createEntry({
              id: replacementId,
              phase: "created",
              parentId,
              metadata: { childSpecName: spec.name },
            }),
          );
          return replacementId;
        },
      });

      const ctx: ReconcileContext = {
        registry,
        manifest: SUPERVISION_MANIFEST,
      };

      const result = await reconciler.reconcile(supervisorId, ctx);
      expect(result.kind).toBe("retry");
      expect(reconciler.isSupervised(blockedChildId)).toBe(false);

      await reconciler[Symbol.asyncDispose]();
    } finally {
      await tree[Symbol.asyncDispose]();
      await baseRegistry[Symbol.asyncDispose]();
    }
  });

  test("rest_for_one handles async rollback lookup rejection without throwing", async () => {
    const baseRegistry = createInMemoryRegistry();
    const tree = createProcessTree(baseRegistry);
    const clock = createFakeClock(1_000);
    const supervisorId = agentId("supervisor-async-lookup");
    const blockedChildId = agentId("a-restart-async");

    let spawnCounter = 0;
    let rejectRollbackLookup = false;

    const registry: AgentRegistry = {
      ...baseRegistry,
      lookup: (id) => {
        if (id === blockedChildId && rejectRollbackLookup) {
          return Promise.reject(new Error("forced async lookup rejection"));
        }
        return baseRegistry.lookup(id);
      },
    };

    try {
      registry.register(createEntry({ id: supervisorId, phase: "running" }));
      registry.register(
        createEntry({
          id: agentId("a-old"),
          phase: "terminated",
          parentId: supervisorId,
          metadata: { childSpecName: "a" },
        }),
      );
      registry.register(
        createEntry({
          id: agentId("b-old"),
          phase: "running",
          parentId: supervisorId,
          metadata: { childSpecName: "b" },
        }),
      );

      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        clock,
        spawnChild: async (
          parentId: AgentId,
          spec: ChildSpec,
          _manifest: AgentManifest,
        ): Promise<AgentId> => {
          if (spec.name === "b") {
            rejectRollbackLookup = true;
            throw new Error("spawn b failed");
          }
          spawnCounter += 1;
          const replacementId = spawnCounter === 1 ? blockedChildId : agentId("a-fallback");
          registry.register(
            createEntry({
              id: replacementId,
              phase: "created",
              parentId,
              metadata: { childSpecName: spec.name },
            }),
          );
          return replacementId;
        },
      });

      const ctx: ReconcileContext = {
        registry,
        manifest: SUPERVISION_MANIFEST,
      };

      const result = await reconciler.reconcile(supervisorId, ctx);
      expect(result.kind).toBe("retry");
      expect(baseRegistry.lookup(supervisorId)?.status.phase).toBe("running");

      await reconciler[Symbol.asyncDispose]();
    } finally {
      await tree[Symbol.asyncDispose]();
      await baseRegistry[Symbol.asyncDispose]();
    }
  });
});
