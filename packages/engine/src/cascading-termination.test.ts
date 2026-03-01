import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentId, ProcessState, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import type { CascadingTermination } from "./cascading-termination.js";
import { createCascadingTermination } from "./cascading-termination.js";
import type { ProcessTree } from "./process-tree.js";
import { createProcessTree } from "./process-tree.js";
import type { InMemoryRegistry } from "./registry.js";
import { createInMemoryRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(
  id: string,
  parentId?: string,
  phase: ProcessState = "created",
  generation = 0,
  agentType: "copilot" | "worker" = "worker",
): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType,
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
    ...(parentId !== undefined ? { parentId: agentId(parentId) } : {}),
  };
}

/** Flush microtasks so async cascade completes with sync registry. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CascadingTermination", () => {
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

  test("children terminated on parent death", async () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child-1", "root", "running", 0));
    registry.register(entry("child-2", "root", "running", 0));

    // Terminate parent
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    // Children should be terminated
    const child1 = registry.lookup(agentId("child-1"));
    const child2 = registry.lookup(agentId("child-2"));
    expect(child1?.status.phase).toBe("terminated");
    expect(child2?.status.phase).toBe("terminated");
  });

  test("deep cascade", async () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));
    registry.register(entry("grandchild", "child", "running", 0));

    // Terminate root
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    // Entire subtree should be terminated
    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");
    expect(registry.lookup(agentId("grandchild"))?.status.phase).toBe("terminated");
  });

  test("skip already-terminated", async () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "terminated", 0));

    // Terminate parent — child already terminated, should not cause error
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");
  });

  test("CAS conflict is graceful", async () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));

    // Advance child's generation so CAS will conflict
    registry.transition(agentId("child"), "waiting", 0, { kind: "awaiting_response" });
    // child is now at generation 1, phase "waiting"
    registry.transition(agentId("child"), "running", 1, { kind: "response_received" });
    // child is now at generation 2, phase "running"

    // Terminate root — cascade will try to terminate child with stale generation
    // But that's OK because cascade reads current status before transitioning
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    // Child should still be terminated (cascade reads current generation)
    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");
  });

  test("inactive after dispose", async () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));

    await cascade[Symbol.asyncDispose]();

    // Terminate root — cascade should no longer fire
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    // Child should still be running
    expect(registry.lookup(agentId("child"))?.status.phase).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Copilot-aware cascade
// ---------------------------------------------------------------------------

describe("CascadingTermination (copilot-aware)", () => {
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

  test("cascade skips copilot children", async () => {
    const cascade = createCascadingTermination(registry, tree);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("worker-child", "root", "running", 0, "worker"));
    registry.register(entry("copilot-child", "root", "running", 0, "copilot"));

    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    // Worker child should be terminated
    expect(registry.lookup(agentId("worker-child"))?.status.phase).toBe("terminated");
    // Copilot child should survive
    expect(registry.lookup(agentId("copilot-child"))?.status.phase).toBe("running");

    await cascade[Symbol.asyncDispose]();
  });

  test("cascade skips copilot subtrees", async () => {
    const cascade = createCascadingTermination(registry, tree);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("copilot-child", "root", "running", 0, "copilot"));
    registry.register(entry("worker-grandchild", "copilot-child", "running", 0, "worker"));

    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    // Copilot child survives — AND its subtree is skipped
    expect(registry.lookup(agentId("copilot-child"))?.status.phase).toBe("running");
    expect(registry.lookup(agentId("worker-grandchild"))?.status.phase).toBe("running");

    await cascade[Symbol.asyncDispose]();
  });

  test("worker subtrees still cascade when mixed", async () => {
    const cascade = createCascadingTermination(registry, tree);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("worker-child", "root", "running", 0, "worker"));
    registry.register(entry("worker-grandchild", "worker-child", "running", 0, "worker"));
    registry.register(entry("copilot-child", "root", "running", 0, "copilot"));

    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    // Worker subtree fully terminated
    expect(registry.lookup(agentId("worker-child"))?.status.phase).toBe("terminated");
    expect(registry.lookup(agentId("worker-grandchild"))?.status.phase).toBe("terminated");
    // Copilot survives
    expect(registry.lookup(agentId("copilot-child"))?.status.phase).toBe("running");

    await cascade[Symbol.asyncDispose]();
  });
});

// ---------------------------------------------------------------------------
// Supervision-aware tests
// ---------------------------------------------------------------------------

describe("CascadingTermination (supervision-aware)", () => {
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

  test("supervised child terminates → cascading defers (grandchildren NOT terminated)", async () => {
    const supervisedChildren = new Set<string>([agentId("child")]);
    const isSupervised = (id: AgentId): boolean => supervisedChildren.has(id);
    const cascade = createCascadingTermination(registry, tree, isSupervised);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));
    registry.register(entry("grandchild", "child", "running", 0));

    // Terminate child — supervised, so cascading should defer
    registry.transition(agentId("child"), "terminated", 0, { kind: "error" });
    await flush();

    // Grandchild should still be running (supervision reconciler handles it)
    expect(registry.lookup(agentId("grandchild"))?.status.phase).toBe("running");

    await cascade[Symbol.asyncDispose]();
  });

  test("unsupervised child terminates → cascading proceeds", async () => {
    const isSupervised = (_id: AgentId): boolean => false;
    const cascade = createCascadingTermination(registry, tree, isSupervised);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));
    registry.register(entry("grandchild", "child", "running", 0));

    // Terminate child — not supervised, cascading proceeds
    registry.transition(agentId("child"), "terminated", 0, { kind: "error" });
    await flush();

    expect(registry.lookup(agentId("grandchild"))?.status.phase).toBe("terminated");

    await cascade[Symbol.asyncDispose]();
  });

  test("supervisor itself terminates → all descendants terminated", async () => {
    // Only child-a is supervised (by "root"), not root itself
    const supervisedChildren = new Set<string>([agentId("child-a")]);
    const isSupervised = (id: AgentId): boolean => supervisedChildren.has(id);
    const cascade = createCascadingTermination(registry, tree, isSupervised);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child-a", "root", "running", 0));
    registry.register(entry("grandchild", "child-a", "running", 0));

    // Terminate root itself (the supervisor) — cascading should proceed for all descendants
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    expect(registry.lookup(agentId("child-a"))?.status.phase).toBe("terminated");
    expect(registry.lookup(agentId("grandchild"))?.status.phase).toBe("terminated");

    await cascade[Symbol.asyncDispose]();
  });

  test("mixed tree: some children supervised, some not", async () => {
    const supervisedChildren = new Set<string>([agentId("supervised-child")]);
    const isSupervised = (id: AgentId): boolean => supervisedChildren.has(id);
    const cascade = createCascadingTermination(registry, tree, isSupervised);

    registry.register(entry("parent", undefined, "running", 0));
    registry.register(entry("supervised-child", "parent", "running", 0));
    registry.register(entry("unsupervised-child", "parent", "running", 0));
    registry.register(entry("grandchild-s", "supervised-child", "running", 0));
    registry.register(entry("grandchild-u", "unsupervised-child", "running", 0));

    // Supervised child terminates — cascading deferred
    registry.transition(agentId("supervised-child"), "terminated", 0, { kind: "error" });
    await flush();
    expect(registry.lookup(agentId("grandchild-s"))?.status.phase).toBe("running");

    // Unsupervised child terminates — cascading proceeds
    registry.transition(agentId("unsupervised-child"), "terminated", 0, { kind: "error" });
    await flush();
    expect(registry.lookup(agentId("grandchild-u"))?.status.phase).toBe("terminated");

    await cascade[Symbol.asyncDispose]();
  });

  test("isSupervised callback not provided → existing behavior preserved", async () => {
    // No isSupervised callback — should cascade everything (backwards compatible)
    const cascade = createCascadingTermination(registry, tree);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));

    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });
    await flush();

    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");

    await cascade[Symbol.asyncDispose]();
  });
});
