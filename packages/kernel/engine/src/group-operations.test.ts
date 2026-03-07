import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProcessState, RegistryEntry } from "@koi/core";
import { AGENT_SIGNALS, agentGroupId, agentId } from "@koi/core";
import type { InMemoryRegistry } from "@koi/engine-reconcile";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { listByGroup, signalGroup } from "./group-operations.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GROUP_A = agentGroupId("group-a");
const GROUP_B = agentGroupId("group-b");

function entry(
  id: string,
  phase: ProcessState = "running",
  generation = 0,
  groupId?: ReturnType<typeof agentGroupId>,
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
    priority: 10,
    ...(groupId !== undefined ? { groupId } : {}),
  };
}

// ---------------------------------------------------------------------------
// listByGroup
// ---------------------------------------------------------------------------

describe("listByGroup", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("returns only agents with matching groupId", () => {
    registry.register(entry("a1", "running", 0, GROUP_A));
    registry.register(entry("a2", "running", 0, GROUP_A));
    registry.register(entry("b1", "running", 0, GROUP_B));

    const members = listByGroup(registry, GROUP_A);
    expect(Array.isArray(members)).toBe(true);
    const ids = (members as readonly RegistryEntry[]).map((m) => m.agentId);
    expect(ids).toContain(agentId("a1"));
    expect(ids).toContain(agentId("a2"));
    expect(ids).not.toContain(agentId("b1"));
  });

  test("returns empty array for unknown groupId", () => {
    registry.register(entry("a1", "running", 0, GROUP_A));

    const members = listByGroup(registry, agentGroupId("unknown-group"));
    expect((members as readonly RegistryEntry[]).length).toBe(0);
  });

  test("excludes agents without groupId", () => {
    registry.register(entry("a1", "running", 0, GROUP_A));
    registry.register(entry("no-group", "running", 0)); // no groupId

    const members = listByGroup(registry, GROUP_A);
    const ids = (members as readonly RegistryEntry[]).map((m) => m.agentId);
    expect(ids).toContain(agentId("a1"));
    expect(ids).not.toContain(agentId("no-group"));
  });
});

// ---------------------------------------------------------------------------
// signalGroup
// ---------------------------------------------------------------------------

describe("signalGroup", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("stop signal transitions all running members to suspended", async () => {
    registry.register(entry("a1", "running", 0, GROUP_A));
    registry.register(entry("a2", "running", 0, GROUP_A));

    await signalGroup(registry, GROUP_A, AGENT_SIGNALS.STOP);

    expect(registry.lookup(agentId("a1"))?.status.phase).toBe("suspended");
    expect(registry.lookup(agentId("a2"))?.status.phase).toBe("suspended");
  });

  test("cont signal resumes all suspended members", async () => {
    registry.register(entry("a1", "suspended", 0, GROUP_A));
    registry.register(entry("a2", "suspended", 0, GROUP_A));

    await signalGroup(registry, GROUP_A, AGENT_SIGNALS.CONT);

    expect(registry.lookup(agentId("a1"))?.status.phase).toBe("running");
    expect(registry.lookup(agentId("a2"))?.status.phase).toBe("running");
  });

  test("term signal terminates all active members", async () => {
    registry.register(entry("a1", "running", 0, GROUP_A));
    registry.register(entry("a2", "waiting", 0, GROUP_A));

    await signalGroup(registry, GROUP_A, AGENT_SIGNALS.TERM);

    expect(registry.lookup(agentId("a1"))?.status.phase).toBe("terminated");
    expect(registry.lookup(agentId("a2"))?.status.phase).toBe("terminated");
  });

  test("empty group is a no-op (no error)", async () => {
    // Should not throw
    await signalGroup(registry, agentGroupId("empty-group"), AGENT_SIGNALS.STOP);
  });

  test("mixed live/terminated group: only live agents are signaled", async () => {
    registry.register(entry("a1", "running", 0, GROUP_A));
    registry.register(entry("a2", "terminated", 0, GROUP_A));

    await signalGroup(registry, GROUP_A, AGENT_SIGNALS.STOP);

    expect(registry.lookup(agentId("a1"))?.status.phase).toBe("suspended");
    // a2 was already terminated — still terminated (skipped in signalGroup)
    expect(registry.lookup(agentId("a2"))?.status.phase).toBe("terminated");
  });

  test("stop is no-op for already-suspended members", async () => {
    registry.register(entry("a1", "suspended", 0, GROUP_A));

    await signalGroup(registry, GROUP_A, AGENT_SIGNALS.STOP);

    // Remains suspended (stop only applies to running/waiting)
    expect(registry.lookup(agentId("a1"))?.status.phase).toBe("suspended");
  });

  test("cont is no-op for running members", async () => {
    registry.register(entry("a1", "running", 0, GROUP_A));

    await signalGroup(registry, GROUP_A, AGENT_SIGNALS.CONT);

    // Remains running (cont only applies to suspended)
    expect(registry.lookup(agentId("a1"))?.status.phase).toBe("running");
  });

  test("deadline timeout rejects if operations exceed deadline", async () => {
    // Create a registry whose transitions are slow (mock by using a frozen registry)
    const slowRegistry = {
      ...registry,
      list: () => [entry("a1", "running", 0, GROUP_A)],
      transition: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return registry.transition(agentId("a1"), "suspended", 0, { kind: "signal_stop" });
      },
    } as unknown as InMemoryRegistry;

    await expect(
      signalGroup(slowRegistry, GROUP_A, AGENT_SIGNALS.STOP, { deadlineMs: 10 }),
    ).rejects.toThrow("signalGroup timeout");
  });

  test("uses ChildHandle when provided", async () => {
    registry.register(entry("a1", "running", 0, GROUP_A));

    const signalCalls: string[] = [];
    const mockHandle = {
      childId: agentId("a1"),
      name: "mock",
      onEvent: () => () => {},
      signal: async (kind: string) => {
        signalCalls.push(kind);
      },
      terminate: async () => {},
      waitForCompletion: async () => ({ childId: agentId("a1"), exitCode: 0 }),
    };

    await signalGroup(registry, GROUP_A, AGENT_SIGNALS.STOP, {
      handles: new Map([[agentId("a1"), mockHandle]]),
    });

    expect(signalCalls).toContain(AGENT_SIGNALS.STOP);
    // Registry should NOT have been transitioned (handle takes over)
    expect(registry.lookup(agentId("a1"))?.status.phase).toBe("running");
  });
});
