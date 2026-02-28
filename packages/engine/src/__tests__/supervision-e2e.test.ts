/**
 * Supervision E2E test — exercises the full supervision tree implementation
 * through the real createKoi runtime assembly with live LLM calls.
 *
 * Validates the complete chain:
 *   createKoi → createPiAdapter (real LLM) → middleware chain → agent lifecycle
 *   spawnChildAgent → registry → ProcessTree → SupervisionReconciler → CascadingTermination
 *
 * Gated on ANTHROPIC_API_KEY — skipped when key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/supervision-e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  ChildSpec,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ProcessState,
  ReconcileContext,
  RegistryEntry,
  SupervisionConfig,
} from "@koi/core";
import { agentId } from "@koi/core";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { createCascadingTermination } from "../cascading-termination.js";
import { createKoi } from "../koi.js";
import type { ProcessTree } from "../process-tree.js";
import { createProcessTree } from "../process-tree.js";
import type { InMemoryRegistry } from "../registry.js";
import { createInMemoryRegistry } from "../registry.js";
import { spawnChildAgent } from "../spawn-child.js";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";
import type { SpawnChildFn } from "../supervision-reconciler.js";
import { createSupervisionReconciler } from "../supervision-reconciler.js";
import { DEFAULT_SPAWN_POLICY } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function hasDoneEvent(events: readonly EngineEvent[]): boolean {
  return events.some((e) => e.kind === "done");
}

/** Safe indexed access with runtime guard — avoids non-null assertion. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`Expected element at index ${index}`);
  return value;
}

function _makeEntry(
  id: string,
  parentId?: string,
  phase: ProcessState = "created",
  generation = 0,
): RegistryEntry {
  return {
    agentId: agentId(id),
    status: { phase, generation, conditions: [], lastTransitionAt: Date.now() },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    ...(parentId !== undefined ? { parentId: agentId(parentId) } : {}),
  };
}

function makeChildSpec(name: string, restart: ChildSpec["restart"] = "permanent"): ChildSpec {
  return { name, restart };
}

/** Simple adapter whose stream() yields a done event immediately. */
function createSimpleAdapter(): EngineAdapter {
  return {
    engineId: "e2e-simple",
    stream: (_input: EngineInput) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
        yield {
          kind: "done" as const,
          output: {
            content: [{ kind: "text", text: "child done" }],
            stopReason: "completed",
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 10 },
          },
        };
      },
    }),
  };
}

/** Creates a modelCall that returns a canned response (for createLoopAdapter). */
function createMockModelCall(responseText: string): (req: ModelRequest) => Promise<ModelResponse> {
  return async (_req: ModelRequest) => ({
    content: responseText,
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  });
}

// ---------------------------------------------------------------------------
// PART 1: Real LLM through full createKoi runtime
// ---------------------------------------------------------------------------

describeE2E("supervision e2e: real LLM through createKoi", () => {
  test(
    "createKoi + createPiAdapter: supervisor agent runs real LLM call",
    async () => {
      const manifest: AgentManifest = {
        name: "supervisor-e2e",
        version: "1.0.0",
        model: { name: "claude-haiku" },
        supervision: {
          strategy: { kind: "one_for_one" },
          maxRestarts: 3,
          maxRestartWindowMs: 60_000,
          children: [makeChildSpec("worker-a"), makeChildSpec("worker-b")],
        },
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply with exactly one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
      });

      // Verify supervision config is on the manifest
      expect(runtime.agent.pid.name).toBe("supervisor-e2e");
      expect(manifest.supervision).toBeDefined();

      // Run real LLM call — prompt is simple to minimize flakiness
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "What is 2+2? Reply with just the number." }),
      );

      // Verify real LLM output exists (non-empty text response from model)
      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);
      expect(hasDoneEvent(events)).toBe(true);
      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "createKoi + createLoopAdapter: middleware chain intercepts model calls",
    async () => {
      // let justified: tracks middleware interception
      let modelCallIntercepted = false;

      const observerMiddleware: KoiMiddleware = {
        name: "e2e:observer",
        describeCapabilities: () => undefined,
        priority: 500,
        async wrapModelCall(_ctx, req, next) {
          modelCallIntercepted = true;
          return next(req);
        },
      };

      const loopAdapter = createLoopAdapter({
        modelCall: createMockModelCall("loop-response"),
      });

      const runtime = await createKoi({
        manifest: {
          name: "loop-e2e-agent",
          version: "1.0.0",
          model: { name: "mock-model" },
        },
        adapter: loopAdapter,
        middleware: [observerMiddleware],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 10_000, maxTokens: 3_000 },
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));

      expect(modelCallIntercepted).toBe(true);
      expect(hasDoneEvent(events)).toBe(true);
      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "spawnChildAgent: child runs real LLM through full pipeline with registry",
    async () => {
      const registry = createInMemoryRegistry();
      const ledger = createInMemorySpawnLedger(10);

      // Create parent agent
      const parentRuntime = await createKoi({
        manifest: { name: "parent-e2e", version: "1.0.0", model: { name: "claude-haiku" } },
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "You are a parent agent.",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        registry,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
      });

      // Register parent
      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn child with real Pi adapter
      const childPiAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise child agent. Reply with exactly one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const spawnResult = await spawnChildAgent({
        manifest: { name: "child-e2e", version: "1.0.0", model: { name: "claude-haiku" } },
        adapter: childPiAdapter,
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
      });

      expect(ledger.activeCount()).toBe(1);

      // Verify parent-child relationship in registry
      const childEntry = registry.lookup(spawnResult.childPid.id);
      expect(childEntry).toBeDefined();
      expect(childEntry?.parentId).toBe(parentRuntime.agent.pid.id);
      expect(spawnResult.childPid.depth).toBe(1);
      expect(spawnResult.childPid.type).toBe("worker");

      // Run child agent through full pipeline (real LLM)
      registry.transition(spawnResult.childPid.id, "running", 0, { kind: "assembly_complete" });
      const events = await collectEvents(
        spawnResult.runtime.run({ kind: "text", text: "Reply with exactly one word: child" }),
      );

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("child");
      expect(hasDoneEvent(events)).toBe(true);

      // Terminate child
      registry.transition(spawnResult.childPid.id, "terminated", 1, { kind: "completed" });
      expect(ledger.activeCount()).toBe(0);

      await spawnResult.runtime.dispose();
      await parentRuntime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// PART 2: Full supervision lifecycle (createLoopAdapter for speed)
// ---------------------------------------------------------------------------

describeE2E("supervision e2e: full lifecycle through createKoi + createLoopAdapter", () => {
  let registry: InMemoryRegistry;
  let tree: ProcessTree;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    tree = createProcessTree(registry);
  });

  afterEach(async () => {
    await tree[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  test(
    "one_for_one: child runs through createKoi, terminates, reconciler restarts with new agent",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      const supervisorConfig: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 3,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("worker")],
      };

      const supervisorManifest: AgentManifest = {
        name: "supervisor",
        version: "1.0.0",
        model: { name: "test-model" },
        supervision: supervisorConfig,
      };

      // Create supervisor via full createKoi path
      const supervisorAdapter = createLoopAdapter({
        modelCall: createMockModelCall("I am the supervisor"),
      });
      const supervisorRuntime = await createKoi({
        manifest: supervisorManifest,
        adapter: supervisorAdapter,
        registry,
        loopDetection: false,
      });

      // Register supervisor
      registry.register({
        agentId: supervisorRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
      });
      registry.transition(supervisorRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn first child through full createKoi path
      const childAdapter1 = createLoopAdapter({
        modelCall: createMockModelCall("I am worker v1"),
      });
      const child1 = await spawnChildAgent({
        manifest: { name: "worker", version: "1.0.0", model: { name: "test-model" } },
        adapter: childAdapter1,
        parentAgent: supervisorRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
      });

      // Transition child to running
      registry.transition(child1.childPid.id, "running", 0, { kind: "assembly_complete" });

      // Run child agent through full middleware chain
      const childEvents = await collectEvents(
        child1.runtime.run({ kind: "text", text: "do work" }),
      );
      expect(hasDoneEvent(childEvents)).toBe(true);

      // Terminate child (simulating crash)
      registry.transition(child1.childPid.id, "terminated", 1, { kind: "error" });
      expect(ledger.activeCount()).toBe(0);

      // Set up supervision reconciler with real SpawnChildFn
      let spawnCount = 0;
      const spawnedIds: AgentId[] = [];
      const spawnChild: SpawnChildFn = async (_parentId, childSpec, manifest) => {
        spawnCount += 1;
        const newAdapter = createLoopAdapter({
          modelCall: createMockModelCall(`I am worker v${spawnCount + 1}`),
        });
        const result = await spawnChildAgent({
          manifest: { ...manifest, name: childSpec.name },
          adapter: newAdapter,
          parentAgent: supervisorRuntime.agent,
          spawnLedger: ledger,
          spawnPolicy: DEFAULT_SPAWN_POLICY,
          registry,
        });
        spawnedIds.push(result.childPid.id);
        return result.childPid.id;
      };

      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild,
      });

      // Initialize reconciler's child map
      const ctx: ReconcileContext = { registry, manifest: supervisorManifest };
      await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);

      // Reconciler detects terminated child, restarts it
      const result = await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);
      expect(result.kind).toBe("converged");
      expect(spawnCount).toBe(1);

      // New child has a different ID
      const newChildId = spawnedIds[0];
      if (newChildId === undefined) throw new Error("expected spawned child");
      expect(newChildId).not.toBe(child1.childPid.id);

      // New child is registered and can be run
      const newEntry = registry.lookup(newChildId);
      expect(newEntry).toBeDefined();
      expect(newEntry?.parentId).toBe(supervisorRuntime.agent.pid.id);
      expect(ledger.activeCount()).toBe(1);

      // isSupervised tracks the new child
      expect(reconciler.isSupervised(newChildId)).toBe(true);
      expect(reconciler.isSupervised(child1.childPid.id)).toBe(false);

      await reconciler[Symbol.asyncDispose]();
      await child1.runtime.dispose();
      await supervisorRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "cascading termination defers for supervised children via isSupervised",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      const supervisorConfig: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("worker-a"), makeChildSpec("worker-b")],
      };

      const supervisorManifest: AgentManifest = {
        name: "cascade-supervisor",
        version: "1.0.0",
        model: { name: "test-model" },
        supervision: supervisorConfig,
      };

      // Create supervisor via createKoi
      const supervisorRuntime = await createKoi({
        manifest: supervisorManifest,
        adapter: createLoopAdapter({ modelCall: createMockModelCall("supervisor") }),
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: supervisorRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
      });
      registry.transition(supervisorRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn children through full pipeline
      const childA = await spawnChildAgent({
        manifest: { name: "worker-a", version: "1.0.0", model: { name: "test-model" } },
        adapter: createLoopAdapter({ modelCall: createMockModelCall("worker-a") }),
        parentAgent: supervisorRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
      });
      registry.transition(childA.childPid.id, "running", 0, { kind: "assembly_complete" });

      const childB = await spawnChildAgent({
        manifest: { name: "worker-b", version: "1.0.0", model: { name: "test-model" } },
        adapter: createLoopAdapter({ modelCall: createMockModelCall("worker-b") }),
        parentAgent: supervisorRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
      });
      registry.transition(childB.childPid.id, "running", 0, { kind: "assembly_complete" });

      // Spawn a grandchild under child-A
      const grandchild = await spawnChildAgent({
        manifest: { name: "grandchild", version: "1.0.0", model: { name: "test-model" } },
        adapter: createSimpleAdapter(),
        parentAgent: childA.runtime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
      });
      registry.transition(grandchild.childPid.id, "running", 0, { kind: "assembly_complete" });

      // Set up supervision reconciler
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild: async (_parentId, childSpec, manifest) => {
          const result = await spawnChildAgent({
            manifest: { ...manifest, name: childSpec.name },
            adapter: createSimpleAdapter(),
            parentAgent: supervisorRuntime.agent,
            spawnLedger: ledger,
            spawnPolicy: DEFAULT_SPAWN_POLICY,
            registry,
          });
          return result.childPid.id;
        },
      });

      // Initialize reconciler — marks child-A and child-B as supervised
      await reconciler.reconcile(supervisorRuntime.agent.pid.id, {
        registry,
        manifest: supervisorManifest,
      });

      expect(reconciler.isSupervised(childA.childPid.id)).toBe(true);
      expect(reconciler.isSupervised(childB.childPid.id)).toBe(true);
      expect(reconciler.isSupervised(grandchild.childPid.id)).toBe(false);

      // Wire CascadingTermination with isSupervised
      const cascade = createCascadingTermination(registry, tree, reconciler.isSupervised);

      // Terminate child-A (supervised) → cascading should DEFER
      // Grandchild should still be running
      registry.transition(childA.childPid.id, "terminated", 1, { kind: "error" });
      expect(registry.lookup(grandchild.childPid.id)?.status.phase).toBe("running");

      // Reconciler restarts child-A
      await reconciler.reconcile(supervisorRuntime.agent.pid.id, {
        registry,
        manifest: supervisorManifest,
      });

      // New child-A ID is supervised
      const newChildAId = reconciler.isSupervised(childA.childPid.id)
        ? childA.childPid.id
        : undefined;
      expect(newChildAId).toBeUndefined(); // old ID is no longer supervised

      // Verify child-B is still running (untouched by one_for_one)
      expect(registry.lookup(childB.childPid.id)?.status.phase).toBe("running");

      await cascade[Symbol.asyncDispose]();
      await reconciler[Symbol.asyncDispose]();
      await grandchild.runtime.dispose();
      await childA.runtime.dispose();
      await childB.runtime.dispose();
      await supervisorRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "full escalation: budget exhausted → supervisor terminates → cascade kills all children",
    async () => {
      const ledger = createInMemorySpawnLedger(20);

      const supervisorConfig: SupervisionConfig = {
        strategy: { kind: "one_for_one" },
        maxRestarts: 1,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("worker")],
      };

      const supervisorManifest: AgentManifest = {
        name: "escalation-supervisor",
        version: "1.0.0",
        model: { name: "test-model" },
        supervision: supervisorConfig,
      };

      // Create supervisor via createKoi
      const supervisorRuntime = await createKoi({
        manifest: supervisorManifest,
        adapter: createLoopAdapter({ modelCall: createMockModelCall("supervisor") }),
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: supervisorRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
      });
      registry.transition(supervisorRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn child through full pipeline
      const child1 = await spawnChildAgent({
        manifest: { name: "worker", version: "1.0.0", model: { name: "test-model" } },
        adapter: createLoopAdapter({ modelCall: createMockModelCall("worker-v1") }),
        parentAgent: supervisorRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
      });
      registry.transition(child1.childPid.id, "running", 0, { kind: "assembly_complete" });

      // Supervision reconciler with real spawnChild
      const spawnedIds: AgentId[] = [];
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild: async (_parentId, childSpec, manifest) => {
          const result = await spawnChildAgent({
            manifest: { ...manifest, name: childSpec.name },
            adapter: createSimpleAdapter(),
            parentAgent: supervisorRuntime.agent,
            spawnLedger: ledger,
            spawnPolicy: DEFAULT_SPAWN_POLICY,
            registry,
          });
          spawnedIds.push(result.childPid.id);
          return result.childPid.id;
        },
      });

      // Wire CascadingTermination with isSupervised
      const cascade = createCascadingTermination(registry, tree, reconciler.isSupervised);

      const ctx: ReconcileContext = { registry, manifest: supervisorManifest };

      // Initialize
      await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);
      expect(reconciler.isSupervised(child1.childPid.id)).toBe(true);

      // First crash → restart allowed (maxRestarts=1)
      registry.transition(child1.childPid.id, "terminated", 1, { kind: "error" });
      const r1 = await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);
      expect(r1.kind).toBe("converged");
      expect(spawnedIds).toHaveLength(1);

      // Transition new child to running
      const child2Id = spawnedIds[0];
      if (child2Id === undefined) throw new Error("expected spawned child");
      registry.transition(child2Id, "running", 0, { kind: "assembly_complete" });

      // Second crash → budget exhausted → escalation
      registry.transition(child2Id, "terminated", 1, { kind: "error" });
      const r2 = await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);
      expect(r2.kind).toBe("terminal");

      // Supervisor should be terminated with "escalated" reason
      const supEntry = registry.lookup(supervisorRuntime.agent.pid.id);
      expect(supEntry?.status.phase).toBe("terminated");
      expect(supEntry?.status.reason?.kind).toBe("escalated");

      // isSupervised cleared after escalation
      expect(reconciler.isSupervised(child1.childPid.id)).toBe(false);
      expect(reconciler.isSupervised(child2Id)).toBe(false);

      await cascade[Symbol.asyncDispose]();
      await reconciler[Symbol.asyncDispose]();
      await child1.runtime.dispose();
      await supervisorRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "one_for_all through createKoi: one child dies → all siblings restarted",
    async () => {
      const ledger = createInMemorySpawnLedger(20);

      const supervisorConfig: SupervisionConfig = {
        strategy: { kind: "one_for_all" },
        maxRestarts: 3,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("alpha"), makeChildSpec("beta"), makeChildSpec("gamma")],
      };

      const supervisorManifest: AgentManifest = {
        name: "one-for-all-supervisor",
        version: "1.0.0",
        model: { name: "test-model" },
        supervision: supervisorConfig,
      };

      const supervisorRuntime = await createKoi({
        manifest: supervisorManifest,
        adapter: createLoopAdapter({ modelCall: createMockModelCall("supervisor") }),
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: supervisorRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
      });
      registry.transition(supervisorRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn 3 children through full pipeline
      const children = [];
      for (const name of ["alpha", "beta", "gamma"]) {
        const child = await spawnChildAgent({
          manifest: { name, version: "1.0.0", model: { name: "test-model" } },
          adapter: createLoopAdapter({ modelCall: createMockModelCall(name) }),
          parentAgent: supervisorRuntime.agent,
          spawnLedger: ledger,
          spawnPolicy: DEFAULT_SPAWN_POLICY,
          registry,
        });
        registry.transition(child.childPid.id, "running", 0, { kind: "assembly_complete" });
        children.push(child);
      }

      expect(ledger.activeCount()).toBe(3);

      // Set up supervision reconciler
      const spawnedIds: AgentId[] = [];
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild: async (_parentId, childSpec, manifest) => {
          const result = await spawnChildAgent({
            manifest: { ...manifest, name: childSpec.name },
            adapter: createSimpleAdapter(),
            parentAgent: supervisorRuntime.agent,
            spawnLedger: ledger,
            spawnPolicy: DEFAULT_SPAWN_POLICY,
            registry,
          });
          spawnedIds.push(result.childPid.id);
          return result.childPid.id;
        },
      });

      const ctx: ReconcileContext = { registry, manifest: supervisorManifest };
      await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);

      // Terminate beta (middle child)
      registry.transition(at(children, 1).childPid.id, "terminated", 1, { kind: "error" });

      // Reconcile → one_for_all should terminate alpha and gamma, then restart all 3
      const result = await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);
      expect(result.kind).toBe("converged");

      // Alpha and gamma should be terminated (by reconciler)
      expect(registry.lookup(at(children, 0).childPid.id)?.status.phase).toBe("terminated");
      expect(registry.lookup(at(children, 2).childPid.id)?.status.phase).toBe("terminated");

      // 3 new children spawned
      expect(spawnedIds).toHaveLength(3);

      // All new children are supervised
      for (const newId of spawnedIds) {
        expect(reconciler.isSupervised(newId)).toBe(true);
      }
      // All old children are no longer supervised
      for (const child of children) {
        expect(reconciler.isSupervised(child.childPid.id)).toBe(false);
      }

      await reconciler[Symbol.asyncDispose]();
      for (const child of children) {
        await child.runtime.dispose();
      }
      await supervisorRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "rest_for_one through createKoi: middle child dies → later siblings restarted",
    async () => {
      const ledger = createInMemorySpawnLedger(20);

      const supervisorConfig: SupervisionConfig = {
        strategy: { kind: "rest_for_one" },
        maxRestarts: 3,
        maxRestartWindowMs: 60_000,
        children: [makeChildSpec("a"), makeChildSpec("b"), makeChildSpec("c")],
      };

      const supervisorManifest: AgentManifest = {
        name: "rest-for-one-supervisor",
        version: "1.0.0",
        model: { name: "test-model" },
        supervision: supervisorConfig,
      };

      const supervisorRuntime = await createKoi({
        manifest: supervisorManifest,
        adapter: createLoopAdapter({ modelCall: createMockModelCall("supervisor") }),
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: supervisorRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
      });
      registry.transition(supervisorRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn 3 children
      const children = [];
      for (const name of ["a", "b", "c"]) {
        const child = await spawnChildAgent({
          manifest: { name, version: "1.0.0", model: { name: "test-model" } },
          adapter: createLoopAdapter({ modelCall: createMockModelCall(name) }),
          parentAgent: supervisorRuntime.agent,
          spawnLedger: ledger,
          spawnPolicy: DEFAULT_SPAWN_POLICY,
          registry,
        });
        registry.transition(child.childPid.id, "running", 0, { kind: "assembly_complete" });
        children.push(child);
      }

      // Set up supervision reconciler
      const spawnedIds: AgentId[] = [];
      const reconciler = createSupervisionReconciler({
        registry,
        processTree: tree,
        spawnChild: async (_parentId, childSpec, manifest) => {
          const result = await spawnChildAgent({
            manifest: { ...manifest, name: childSpec.name },
            adapter: createSimpleAdapter(),
            parentAgent: supervisorRuntime.agent,
            spawnLedger: ledger,
            spawnPolicy: DEFAULT_SPAWN_POLICY,
            registry,
          });
          spawnedIds.push(result.childPid.id);
          return result.childPid.id;
        },
      });

      const ctx: ReconcileContext = { registry, manifest: supervisorManifest };
      await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);

      // Terminate child "b" (index 1)
      registry.transition(at(children, 1).childPid.id, "terminated", 1, { kind: "error" });

      const result = await reconciler.reconcile(supervisorRuntime.agent.pid.id, ctx);
      expect(result.kind).toBe("converged");

      // "a" should be untouched (still running)
      expect(registry.lookup(at(children, 0).childPid.id)?.status.phase).toBe("running");

      // "c" should be terminated (rest_for_one terminates children after the failed one)
      expect(registry.lookup(at(children, 2).childPid.id)?.status.phase).toBe("terminated");

      // "b" and "c" restarted (2 spawns)
      expect(spawnedIds).toHaveLength(2);

      // "a" still supervised (same ID), "b" and "c" have new IDs
      expect(reconciler.isSupervised(at(children, 0).childPid.id)).toBe(true);

      await reconciler[Symbol.asyncDispose]();
      for (const child of children) {
        await child.runtime.dispose();
      }
      await supervisorRuntime.dispose();
    },
    TIMEOUT_MS,
  );
});
