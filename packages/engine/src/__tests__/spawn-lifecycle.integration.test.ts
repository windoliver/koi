/**
 * Spawn lifecycle integration tests — exercises the full spawnChildAgent()
 * pipeline with real registry, ledger, and cascading termination.
 *
 * Verifies the complete lifecycle: parent → spawn → child runs → terminates,
 * with ledger slot management, tool inheritance, and cascade behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  ChildLifecycleEvent,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { agentId, toolToken } from "@koi/core";
import { createCascadingTermination } from "../cascading-termination.js";
import { createProcessTree } from "../process-tree.js";
import type { InMemoryRegistry } from "../registry.js";
import { createInMemoryRegistry } from "../registry.js";
import { spawnChildAgent } from "../spawn-child.js";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";
import type { SpawnChildOptions } from "../types.js";
import { DEFAULT_SPAWN_POLICY } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "child-agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function mockOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 100,
    },
  };
}

/**
 * Creates an adapter whose `stream()` yields tool calls via callHandlers,
 * then a final done event. This exercises the full middleware pipeline.
 */
function createTestAdapter(
  toolCalls?: readonly {
    readonly toolId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[],
): EngineAdapter {
  return {
    engineId: "lifecycle-test",
    stream: (input: EngineInput) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
        if (input.callHandlers && toolCalls !== undefined) {
          for (const call of toolCalls) {
            try {
              await input.callHandlers.toolCall({
                toolId: call.toolId,
                input: call.input,
              });
            } catch {
              // Tool call errors are expected in some tests
            }
          }
        }
        yield { kind: "done" as const, output: mockOutput() };
      },
    }),
  };
}

function mockTool(name: string): Tool {
  return {
    descriptor: {
      name,
      description: `Mock tool ${name}`,
      inputSchema: { type: "object" },
    },
    trustTier: "sandbox",
    execute: async () => ({ result: name }),
  };
}

function mockParentAgent(depth = 0, tools?: ReadonlyMap<string, unknown>): Agent {
  const components = tools ?? new Map<string, unknown>();
  return {
    pid: {
      id: agentId("parent-integ"),
      name: "parent",
      type: "copilot",
      depth,
    },
    manifest: { name: "parent", version: "0.1.0", model: { name: "test" } },
    state: "running",
    component: <T>(tok: SubsystemToken<T>) => components.get(tok as string) as T | undefined,
    has: (tok) => components.has(tok as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: () => components as ReadonlyMap<string, unknown>,
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

function baseOptions(overrides?: Partial<SpawnChildOptions>): SpawnChildOptions {
  return {
    manifest: testManifest(),
    adapter: createTestAdapter(),
    parentAgent: mockParentAgent(),
    spawnLedger: createInMemorySpawnLedger(10),
    spawnPolicy: DEFAULT_SPAWN_POLICY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawn lifecycle integration", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("full lifecycle: spawn → run → terminate → slot released", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const result = await spawnChildAgent(baseOptions({ spawnLedger: ledger, registry }));

    expect(ledger.activeCount()).toBe(1);

    // Transition child: created → running
    registry.transition(result.childPid.id, "running", 0, {
      kind: "assembly_complete",
    });

    // Run the child agent — exercises the full engine pipeline
    const events = await collectEvents(result.runtime.run({ kind: "text", text: "do work" }));

    // Should get at least a done event
    expect(events.length).toBeGreaterThanOrEqual(1);
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();

    // Terminate child
    registry.transition(result.childPid.id, "terminated", 1, {
      kind: "completed",
    });

    // Ledger slot released
    expect(ledger.activeCount()).toBe(0);
  });

  test("inherited tools accessible during child execution", async () => {
    const calcTool = mockTool("calc");
    const parentTools = new Map<string, unknown>([[toolToken("calc") as string, calcTool]]);
    const parent = mockParentAgent(0, parentTools);

    const result = await spawnChildAgent(baseOptions({ parentAgent: parent, registry }));

    // Verify tool is inherited
    const inherited = result.runtime.agent.component(toolToken("calc"));
    expect(inherited).toBeDefined();
    expect(inherited?.descriptor.name).toBe("calc");

    // Run the child — tool should be available throughout execution
    const events = await collectEvents(result.runtime.run({ kind: "text", text: "use calc" }));
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Tool still accessible after run
    const afterRun = result.runtime.agent.component(toolToken("calc"));
    expect(afterRun).toBe(calcTool);
  });

  test("multiple children share ledger correctly", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const parent = mockParentAgent(0);

    const child1 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );
    const child2 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );
    const child3 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );

    expect(ledger.activeCount()).toBe(3);

    // Terminate child2 first (out of order)
    registry.transition(child2.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(child2.childPid.id, "terminated", 1, { kind: "completed" });
    expect(ledger.activeCount()).toBe(2);

    // Terminate child1
    registry.transition(child1.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(child1.childPid.id, "terminated", 1, { kind: "completed" });
    expect(ledger.activeCount()).toBe(1);

    // Terminate child3
    registry.transition(child3.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(child3.childPid.id, "terminated", 1, { kind: "completed" });
    expect(ledger.activeCount()).toBe(0);
  });

  test("child failure releases ledger slot", async () => {
    const ledger = createInMemorySpawnLedger(10);

    const result = await spawnChildAgent(baseOptions({ spawnLedger: ledger, registry }));

    expect(ledger.activeCount()).toBe(1);

    // Child fails (transitions directly to terminated with error reason)
    registry.transition(result.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(result.childPid.id, "terminated", 1, { kind: "error" });

    // Ledger slot still released on failure
    expect(ledger.activeCount()).toBe(0);
  });

  test("registry tracks parent-child relationship", async () => {
    const parent = mockParentAgent(0);

    const result = await spawnChildAgent(baseOptions({ parentAgent: parent, registry }));

    // Verify registry entry
    const entry = registry.lookup(result.childPid.id);
    expect(entry).toBeDefined();
    expect(entry?.parentId).toBe(parent.pid.id);
    expect(entry?.agentType).toBe("worker");
    expect(entry?.status.phase).toBe("created");
  });

  test("ChildHandle fires events through full lifecycle", async () => {
    const events: ChildLifecycleEvent[] = [];

    const result = await spawnChildAgent(baseOptions({ registry }));

    result.handle.onEvent((e) => events.push(e));

    // created → running → terminated (with completed reason)
    registry.transition(result.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(result.childPid.id, "terminated", 1, { kind: "completed" });

    // started + completed + terminated = 3 events
    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe("started");
    expect(events[0]?.childId).toBe(result.childPid.id);
    expect(events[1]?.kind).toBe("completed");
    expect(events[2]?.kind).toBe("terminated");
    expect(events[2]?.childId).toBe(result.childPid.id);
  });

  test("cascading termination: parent death kills all children and releases slots", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const parent = mockParentAgent(0);

    // Wire up CascadingTermination (centralized, replaces per-child watcher)
    const tree = createProcessTree(registry);
    const cascade = createCascadingTermination(registry, tree);

    // Register parent
    registry.register({
      agentId: parent.pid.id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "copilot",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(parent.pid.id, "running", 0, { kind: "assembly_complete" });

    // Spawn 3 children
    const child1 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );
    const child2 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );
    const child3 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );

    // Move all children to running
    registry.transition(child1.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(child2.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(child3.childPid.id, "running", 0, { kind: "assembly_complete" });

    expect(ledger.activeCount()).toBe(3);

    // Parent dies — CascadingTermination cascades to children
    registry.transition(parent.pid.id, "terminated", 1, { kind: "error" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // All children should be cascade-terminated
    expect(registry.lookup(child1.childPid.id)?.status.phase).toBe("terminated");
    expect(registry.lookup(child2.childPid.id)?.status.phase).toBe("terminated");
    expect(registry.lookup(child3.childPid.id)?.status.phase).toBe("terminated");

    // All ledger slots released
    expect(ledger.activeCount()).toBe(0);

    await cascade[Symbol.asyncDispose]();
    await tree[Symbol.asyncDispose]();
  });

  test("child PID has correct depth and parent reference", async () => {
    const parent = mockParentAgent(2);

    const result = await spawnChildAgent(baseOptions({ parentAgent: parent, registry }));

    expect(result.childPid.depth).toBe(3);
    expect(result.childPid.type).toBe("worker");
    expect(result.childPid.parent).toBe(parent.pid.id);
    expect(result.childPid.name).toBe("child-agent");
  });

  test("copilot child survives parent termination, worker child dies", async () => {
    const parent = mockParentAgent(0);

    const tree = createProcessTree(registry);
    const cascade = createCascadingTermination(registry, tree);

    registry.register({
      agentId: parent.pid.id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "copilot",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(parent.pid.id, "running", 0, { kind: "assembly_complete" });

    // Spawn a copilot child (lifecycle: "copilot")
    const copilotChild = await spawnChildAgent(
      baseOptions({
        manifest: testManifest({ lifecycle: "copilot" }),
        parentAgent: parent,
        registry,
      }),
    );

    // Spawn a worker child (default lifecycle)
    const workerChild = await spawnChildAgent(
      baseOptions({
        manifest: testManifest({ lifecycle: "worker" }),
        parentAgent: parent,
        registry,
      }),
    );

    registry.transition(copilotChild.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(workerChild.childPid.id, "running", 0, { kind: "assembly_complete" });

    // Parent dies
    registry.transition(parent.pid.id, "terminated", 1, { kind: "completed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Copilot survives, worker dies
    expect(registry.lookup(copilotChild.childPid.id)?.status.phase).toBe("running");
    expect(registry.lookup(workerChild.childPid.id)?.status.phase).toBe("terminated");

    await cascade[Symbol.asyncDispose]();
    await tree[Symbol.asyncDispose]();
  });

  test("spawner lineage query through ProcessTree", async () => {
    const parent = mockParentAgent(0);
    const tree = createProcessTree(registry);

    // Register parent
    registry.register({
      agentId: parent.pid.id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "copilot",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });

    // Spawn child (child's spawner = parent)
    const child = await spawnChildAgent(baseOptions({ parentAgent: parent, registry }));

    // Verify lineage
    const lin = tree.lineage(child.childPid.id);
    expect(lin).toEqual([parent.pid.id]);

    // Root has empty lineage
    expect(tree.lineage(parent.pid.id)).toEqual([]);

    await tree[Symbol.asyncDispose]();
  });

  test("signal delivers to child handle listeners", async () => {
    const result = await spawnChildAgent(baseOptions({ registry }));
    registry.transition(result.childPid.id, "running", 0, { kind: "assembly_complete" });

    const events: ChildLifecycleEvent[] = [];
    result.handle.onEvent((e) => events.push(e));

    await result.handle.signal("graceful_shutdown");

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("signaled");
    if (events[0]?.kind === "signaled") {
      expect(events[0].signal).toBe("graceful_shutdown");
    }
  });
});
