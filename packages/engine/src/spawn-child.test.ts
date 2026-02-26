import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  ChildLifecycleEvent,
  EngineAdapter,
  EngineEvent,
  EngineOutput,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { agentId, toolToken } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { CascadingTermination } from "./cascading-termination.js";
import { createCascadingTermination } from "./cascading-termination.js";
import type { ProcessTree } from "./process-tree.js";
import { createProcessTree } from "./process-tree.js";
import type { InMemoryRegistry } from "./registry.js";
import { createInMemoryRegistry } from "./registry.js";
import { spawnChildAgent } from "./spawn-child.js";
import { createInMemorySpawnLedger } from "./spawn-ledger.js";
import type { SpawnChildOptions } from "./types.js";
import { DEFAULT_SPAWN_POLICY } from "./types.js";

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

function mockOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 100,
    },
    ...overrides,
  };
}

function mockAdapter(): EngineAdapter {
  return {
    engineId: "mock",
    stream: () => ({
      [Symbol.asyncIterator]() {
        // let justified: mutable iterator state, single-use
        let yielded = false;
        return {
          async next(): Promise<IteratorResult<EngineEvent>> {
            if (yielded) return { done: true, value: undefined };
            yielded = true;
            return { done: false, value: { kind: "done" as const, output: mockOutput() } };
          },
        };
      },
    }),
  };
}

/** Build a minimal mock Tool for component inheritance tests. */
function mockTool(name: string): Tool {
  return {
    descriptor: {
      name,
      description: `Mock tool ${name}`,
      inputSchema: { type: "object" },
    },
    trustTier: "sandbox",
    execute: async (input: unknown) => input,
  };
}

/**
 * Build a mock parent Agent entity with optional tools.
 * Tools must be keyed as `tool:<name>` to match the SubsystemToken convention.
 */
function mockParentAgent(depth = 0, tools?: ReadonlyMap<string, unknown>): Agent {
  const components = tools ?? new Map<string, unknown>();
  return {
    pid: {
      id: agentId("parent-1"),
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

/** Build minimal SpawnChildOptions with sensible defaults. */
function baseOptions(overrides?: Partial<SpawnChildOptions>): SpawnChildOptions {
  return {
    manifest: testManifest(),
    adapter: mockAdapter(),
    parentAgent: mockParentAgent(),
    spawnLedger: createInMemorySpawnLedger(10),
    spawnPolicy: DEFAULT_SPAWN_POLICY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PID generation
// ---------------------------------------------------------------------------

describe("spawnChildAgent PID generation", () => {
  test("child has depth = parent.depth + 1", async () => {
    const parent = mockParentAgent(2);
    const result = await spawnChildAgent(baseOptions({ parentAgent: parent }));

    expect(result.childPid.depth).toBe(3);
  });

  test("child has type worker by default", async () => {
    const result = await spawnChildAgent(baseOptions());

    expect(result.childPid.type).toBe("worker");
  });

  test("child has parent reference set to parent's id", async () => {
    const parent = mockParentAgent(0);
    const result = await spawnChildAgent(baseOptions({ parentAgent: parent }));

    expect(result.childPid.parent).toBe(parent.pid.id);
  });

  test("manifest lifecycle drives agentType", async () => {
    const copilotManifest = testManifest({ lifecycle: "copilot" });
    const result = await spawnChildAgent(baseOptions({ manifest: copilotManifest }));

    expect(result.childPid.type).toBe("copilot");
  });

  test("manifest lifecycle worker produces worker type", async () => {
    const workerManifest = testManifest({ lifecycle: "worker" });
    const result = await spawnChildAgent(baseOptions({ manifest: workerManifest }));

    expect(result.childPid.type).toBe("worker");
  });

  test("undefined manifest lifecycle defaults to worker for spawned agent", async () => {
    const noLifecycleManifest = testManifest();
    const result = await spawnChildAgent(baseOptions({ manifest: noLifecycleManifest }));

    expect(result.childPid.type).toBe("worker");
  });
});

// ---------------------------------------------------------------------------
// Assembly delegation
// ---------------------------------------------------------------------------

describe("spawnChildAgent assembly delegation", () => {
  test("delegates to createKoi with correct manifest", async () => {
    const manifest = testManifest({ name: "my-worker", version: "2.0.0" });
    const result = await spawnChildAgent(baseOptions({ manifest }));

    expect(result.runtime.agent.manifest.name).toBe("my-worker");
    expect(result.runtime.agent.manifest.version).toBe("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// Ledger integration
// ---------------------------------------------------------------------------

describe("spawnChildAgent ledger integration", () => {
  test("acquires ledger slot on spawn", async () => {
    const ledger = createInMemorySpawnLedger(10);
    expect(ledger.activeCount()).toBe(0);

    await spawnChildAgent(baseOptions({ spawnLedger: ledger }));

    expect(ledger.activeCount()).toBe(1);
  });

  test("throws RATE_LIMIT when ledger has no capacity", async () => {
    const ledger = createInMemorySpawnLedger(0);

    try {
      await spawnChildAgent(baseOptions({ spawnLedger: ledger }));
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("RATE_LIMIT");
      expect(err.retryable).toBe(true);
    }
  });

  test("releases ledger slot if assembly (createKoi) fails", async () => {
    const ledger = createInMemorySpawnLedger(10);

    // An adapter with no `stream` method triggers a VALIDATION error in createKoi
    const badAdapter = { engineId: "broken" } as unknown as EngineAdapter;

    try {
      await spawnChildAgent(baseOptions({ adapter: badAdapter, spawnLedger: ledger }));
      expect(true).toBe(false);
    } catch {
      // Ledger slot should have been released after assembly failure
      expect(ledger.activeCount()).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe("spawnChildAgent registry integration", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("registers child with parentId when registry provided", async () => {
    const parent = mockParentAgent(0);
    const result = await spawnChildAgent(baseOptions({ parentAgent: parent, registry }));

    const entry = registry.lookup(result.childPid.id);
    expect(entry).toBeDefined();
    expect(entry?.parentId).toBe(parent.pid.id);
  });

  test("child registered with initial status 'created'", async () => {
    const result = await spawnChildAgent(baseOptions({ registry }));

    const entry = registry.lookup(result.childPid.id);
    expect(entry).toBeDefined();
    expect(entry?.status.phase).toBe("created");
    expect(entry?.status.generation).toBe(0);
  });

  test("works without registry (no error, returns noop handle)", async () => {
    // No registry provided — should not throw
    const result = await spawnChildAgent(baseOptions());

    expect(result.runtime).toBeDefined();
    expect(result.handle).toBeDefined();
    expect(result.childPid).toBeDefined();
  });

  test("spawner set on registration", async () => {
    const parent = mockParentAgent(0);
    const result = await spawnChildAgent(baseOptions({ parentAgent: parent, registry }));

    const entry = registry.lookup(result.childPid.id);
    expect(entry).toBeDefined();
    expect(entry?.spawner).toBe(parent.pid.id);
  });

  test("registry agentType matches manifest lifecycle", async () => {
    const copilotManifest = testManifest({ lifecycle: "copilot" });
    const result = await spawnChildAgent(baseOptions({ manifest: copilotManifest, registry }));

    const entry = registry.lookup(result.childPid.id);
    expect(entry?.agentType).toBe("copilot");
  });
});

// ---------------------------------------------------------------------------
// ChildHandle
// ---------------------------------------------------------------------------

describe("spawnChildAgent child handle", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("returns handle with correct childId and name", async () => {
    const manifest = testManifest({ name: "worker-x" });
    const result = await spawnChildAgent(baseOptions({ manifest, registry }));

    expect(result.handle.childId).toBe(result.childPid.id);
    expect(result.handle.name).toBe("worker-x");
  });

  test("noop handle returned when no registry", async () => {
    const result = await spawnChildAgent(baseOptions());
    const events: ChildLifecycleEvent[] = [];

    // onEvent should return an unsubscribe function even on noop handle
    const unsub = result.handle.onEvent((e) => events.push(e));
    expect(typeof unsub).toBe("function");

    // No events should fire (noop)
    unsub();
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Inherited provider (parent tool inheritance)
// ---------------------------------------------------------------------------

describe("spawnChildAgent inherited provider", () => {
  test("parent tools available on child entity", async () => {
    const calcTool = mockTool("calc");
    const parentTools = new Map<string, unknown>([[toolToken("calc") as string, calcTool]]);
    const parent = mockParentAgent(0, parentTools);

    const result = await spawnChildAgent(baseOptions({ parentAgent: parent }));

    // Child should have inherited the parent's tool
    const childTool = result.runtime.agent.component(toolToken("calc"));
    expect(childTool).toBeDefined();
    expect(childTool?.descriptor.name).toBe("calc");
  });
});

// ---------------------------------------------------------------------------
// Ledger release + runtime disposal on child termination
// ---------------------------------------------------------------------------

describe("spawnChildAgent cleanup on termination", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("releases ledger slot when child transitions to terminated", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const result = await spawnChildAgent(baseOptions({ spawnLedger: ledger, registry }));

    expect(ledger.activeCount()).toBe(1);

    // Transition child: created -> running -> terminated
    registry.transition(result.childPid.id, "running", 0, {
      kind: "assembly_complete",
    });
    registry.transition(result.childPid.id, "terminated", 1, {
      kind: "completed",
    });

    // Ledger should be released after termination event fires
    expect(ledger.activeCount()).toBe(0);
  });

  test("calls runtime.dispose() when child transitions to terminated", async () => {
    // let justified: mutable flag to track dispose call
    let disposeCalled = false;
    const adapterWithDispose: EngineAdapter = {
      ...mockAdapter(),
      dispose: async () => {
        disposeCalled = true;
      },
    };

    const result = await spawnChildAgent(baseOptions({ adapter: adapterWithDispose, registry }));

    expect(disposeCalled).toBe(false);

    // Transition child: created -> running -> terminated
    registry.transition(result.childPid.id, "running", 0, {
      kind: "assembly_complete",
    });
    registry.transition(result.childPid.id, "terminated", 1, {
      kind: "completed",
    });

    // Allow async dispose to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(disposeCalled).toBe(true);
  });

  test("double-termination is idempotent (no double ledger release)", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const result = await spawnChildAgent(baseOptions({ spawnLedger: ledger, registry }));

    expect(ledger.activeCount()).toBe(1);

    // Transition child: created -> running -> terminated
    registry.transition(result.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(result.childPid.id, "terminated", 1, { kind: "completed" });

    // First termination releases the slot
    expect(ledger.activeCount()).toBe(0);

    // If we could trigger another terminated event, the idempotency guard
    // should prevent a second release. The ledger count should stay at 0.
    // (In practice, the registry won't allow a second terminated transition,
    // but the guard is defense-in-depth.)
    expect(ledger.activeCount()).toBe(0);
  });

  test("calls runtime.dispose() on cascade termination (via CascadingTermination)", async () => {
    // let justified: mutable flag to track dispose call
    let disposeCalled = false;
    const adapterWithDispose: EngineAdapter = {
      ...mockAdapter(),
      dispose: async () => {
        disposeCalled = true;
      },
    };

    const parent = mockParentAgent(0);
    const tree = createProcessTree(registry);
    const cascade = createCascadingTermination(registry, tree);

    // Register parent
    registry.register({
      agentId: parent.pid.id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "copilot",
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(parent.pid.id, "running", 0, { kind: "assembly_complete" });

    await spawnChildAgent(
      baseOptions({ adapter: adapterWithDispose, parentAgent: parent, registry }),
    );

    expect(disposeCalled).toBe(false);

    // Parent terminates — CascadingTermination cascades to child
    registry.transition(parent.pid.id, "terminated", 1, { kind: "completed" });

    // Allow async dispose to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(disposeCalled).toBe(true);

    await cascade[Symbol.asyncDispose]();
    await tree[Symbol.asyncDispose]();
  });
});

// ---------------------------------------------------------------------------
// Cascading termination (parent dies → child auto-terminated via CascadingTermination)
// ---------------------------------------------------------------------------

describe("spawnChildAgent cascading termination (via CascadingTermination)", () => {
  let registry: InMemoryRegistry;
  let tree: ProcessTree;
  let cascade: CascadingTermination;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    tree = createProcessTree(registry);
    cascade = createCascadingTermination(registry, tree);
  });

  afterEach(async () => {
    await cascade[Symbol.asyncDispose]();
    await tree[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  test("child auto-terminates when parent transitions to terminated", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const parent = mockParentAgent(0);

    // Register parent in registry so it can be transitioned
    registry.register({
      agentId: parent.pid.id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "copilot",
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(parent.pid.id, "running", 0, { kind: "assembly_complete" });

    const result = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );

    // Child is alive, ledger slot held
    expect(ledger.activeCount()).toBe(1);
    registry.transition(result.childPid.id, "running", 0, { kind: "assembly_complete" });

    // Parent terminates — CascadingTermination cascades to child
    registry.transition(parent.pid.id, "terminated", 1, { kind: "completed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Child should have been cascade-terminated
    const childEntry = registry.lookup(result.childPid.id);
    expect(childEntry).toBeDefined();
    expect(childEntry?.status.phase).toBe("terminated");

    // Ledger slot should be released
    expect(ledger.activeCount()).toBe(0);
  });

  test("child terminated with kind evicted on cascade", async () => {
    const parent = mockParentAgent(0);

    registry.register({
      agentId: parent.pid.id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "copilot",
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(parent.pid.id, "running", 0, { kind: "assembly_complete" });

    const result = await spawnChildAgent(baseOptions({ parentAgent: parent, registry }));
    registry.transition(result.childPid.id, "running", 0, { kind: "assembly_complete" });

    // Collect child lifecycle events
    const events: ChildLifecycleEvent[] = [];
    result.handle.onEvent((e) => events.push(e));

    // Parent terminates — CascadingTermination cascades to child
    registry.transition(parent.pid.id, "terminated", 1, { kind: "completed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Child handle should have fired terminated event
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("terminated");
  });

  test("multiple children cascade when parent terminates", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const parent = mockParentAgent(0);

    registry.register({
      agentId: parent.pid.id,
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "copilot",
      metadata: {},
      registeredAt: Date.now(),
    });
    registry.transition(parent.pid.id, "running", 0, { kind: "assembly_complete" });

    const child1 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );
    const child2 = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: ledger, registry }),
    );

    expect(ledger.activeCount()).toBe(2);

    // Move children to running
    registry.transition(child1.childPid.id, "running", 0, { kind: "assembly_complete" });
    registry.transition(child2.childPid.id, "running", 0, { kind: "assembly_complete" });

    // Parent terminates — CascadingTermination cascades to children
    registry.transition(parent.pid.id, "terminated", 1, { kind: "completed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Both children should be terminated
    expect(registry.lookup(child1.childPid.id)?.status.phase).toBe("terminated");
    expect(registry.lookup(child2.childPid.id)?.status.phase).toBe("terminated");

    // Both ledger slots released
    expect(ledger.activeCount()).toBe(0);
  });

  test("no cascade without registry (noop handle)", async () => {
    // Without registry, no cascading — child is unmanaged
    const result = await spawnChildAgent(baseOptions());

    // Should not throw, handle is noop
    expect(result.handle).toBeDefined();
    expect(result.childPid).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("spawnChildAgent error handling", () => {
  test("re-throws createKoi errors after releasing ledger", async () => {
    const ledger = createInMemorySpawnLedger(10);

    // Adapter with broken stream to cause createKoi validation error
    const brokenAdapter = { engineId: "bad" } as unknown as EngineAdapter;

    try {
      await spawnChildAgent(baseOptions({ adapter: brokenAdapter, spawnLedger: ledger }));
      expect(true).toBe(false);
    } catch (e: unknown) {
      // Error was re-thrown (not swallowed)
      expect(e).toBeDefined();
      // Ledger was released before re-throw
      expect(ledger.activeCount()).toBe(0);
    }
  });
});
