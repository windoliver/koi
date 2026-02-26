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
    metadata: {},
    registeredAt: Date.now(),
    ...(parentId !== undefined ? { parentId: agentId(parentId) } : {}),
  };
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

  test("children terminated on parent death", () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child-1", "root", "running", 0));
    registry.register(entry("child-2", "root", "running", 0));

    // Terminate parent
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });

    // Children should be terminated
    const child1 = registry.lookup(agentId("child-1"));
    const child2 = registry.lookup(agentId("child-2"));
    expect(child1?.status.phase).toBe("terminated");
    expect(child2?.status.phase).toBe("terminated");
  });

  test("deep cascade", () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));
    registry.register(entry("grandchild", "child", "running", 0));

    // Terminate root
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });

    // Entire subtree should be terminated
    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");
    expect(registry.lookup(agentId("grandchild"))?.status.phase).toBe("terminated");
  });

  test("skip already-terminated", () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "terminated", 0));

    // Terminate parent — child already terminated, should not cause error
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });

    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");
  });

  test("CAS conflict is graceful", () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));

    // Advance child's generation so CAS will conflict
    registry.transition(agentId("child"), "waiting", 0, { kind: "awaiting_response" });
    // child is now at generation 1, phase "waiting"
    registry.transition(agentId("child"), "running", 1, { kind: "response_received" });
    // child is now at generation 2, phase "running"

    // Terminate root — cascade will try to terminate child with stale generation
    // But that's OK because tree.descendantsOf will find the child, and we read
    // its current status before transitioning
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });

    // Child should still be terminated (cascade reads current generation)
    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");
  });

  test("inactive after dispose", async () => {
    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));

    await cascade[Symbol.asyncDispose]();

    // Terminate root — cascade should no longer fire
    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });

    // Child should still be running
    expect(registry.lookup(agentId("child"))?.status.phase).toBe("running");
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
    expect(registry.lookup(agentId("grandchild-s"))?.status.phase).toBe("running");

    // Unsupervised child terminates — cascading proceeds
    registry.transition(agentId("unsupervised-child"), "terminated", 0, { kind: "error" });
    expect(registry.lookup(agentId("grandchild-u"))?.status.phase).toBe("terminated");

    await cascade[Symbol.asyncDispose]();
  });

  test("isSupervised callback not provided → existing behavior preserved", async () => {
    // No isSupervised callback — should cascade everything (backwards compatible)
    const cascade = createCascadingTermination(registry, tree);

    registry.register(entry("root", undefined, "running", 0));
    registry.register(entry("child", "root", "running", 0));

    registry.transition(agentId("root"), "terminated", 0, { kind: "completed" });

    expect(registry.lookup(agentId("child"))?.status.phase).toBe("terminated");

    await cascade[Symbol.asyncDispose]();
  });
});
