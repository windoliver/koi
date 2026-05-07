import { beforeEach, describe, expect, test } from "bun:test";
import { agentId, type RegistryEntry } from "@koi/core";
import { createNexusRegistry } from "./nexus-registry.js";
import { createMockTransport, type MockTransport } from "./test-helpers.js";

function makeEntry(id: string, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase: "running",
      generation: 0,
      conditions: [],
      lastTransitionAt: 1_700_000_000_000,
    },
    agentType: "worker",
    metadata: {},
    registeredAt: 1_700_000_000_000,
    priority: 10,
    ...overrides,
  };
}

function stubEmptyList(transport: MockTransport): void {
  transport.stub("list_agents", async () => ({ ok: true, value: [] }));
}

function stubRegisterFlow(transport: MockTransport, id: string): void {
  transport.stub("register_agent", async () => ({
    ok: true,
    value: { agent_id: id, state: "UNKNOWN", generation: 0 },
  }));
  transport.stub("agent_transition", async (params) => ({
    ok: true,
    value: {
      agent_id: id,
      state: params.target_state as string,
      generation: ((params.expected_generation as number) ?? 0) + 1,
    },
  }));
  transport.stub("update_agent_metadata", async () => ({
    ok: true,
    value: { agent_id: id, state: "CONNECTED", generation: 99 },
  }));
}

describe("createNexusRegistry — startup", () => {
  let transport: MockTransport;
  beforeEach(() => {
    transport = createMockTransport();
  });

  test("performs eager warmup with empty Nexus", async () => {
    stubEmptyList(transport);
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    expect((await Promise.resolve(registry.list())).length).toBe(0);
    await registry[Symbol.asyncDispose]();
  });

  test("loads existing agents on startup", async () => {
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a1", state: "CONNECTED", generation: 0 }],
    }));
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a1",
        state: "CONNECTED",
        generation: 0,
        metadata: { agentType: "worker", priority: 10, registeredAt: 1 },
      },
    }));
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    expect((await Promise.resolve(registry.list())).length).toBe(1);
    expect(registry.lookup(agentId("a1"))).toBeDefined();
    await registry[Symbol.asyncDispose]();
  });

  test("rejects invalid config", async () => {
    stubEmptyList(transport);
    await expect(createNexusRegistry({ transport, pollIntervalMs: -1 })).rejects.toThrow(
      /pollIntervalMs/,
    );
  });

  test("propagates Nexus list error during warmup", async () => {
    transport.stub("list_agents", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "connection refused", retryable: true },
    }));
    await expect(createNexusRegistry({ transport, pollIntervalMs: 0 })).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe("createNexusRegistry — register", () => {
  let transport: MockTransport;
  beforeEach(() => {
    transport = createMockTransport();
    stubEmptyList(transport);
  });

  test("registers a new agent and emits event", async () => {
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const events: string[] = [];
    registry.watch((e) => events.push(e.kind));

    const entry = makeEntry("a1");
    const result = await registry.register(entry);

    expect(result.agentId).toBe(agentId("a1"));
    expect(registry.lookup(agentId("a1"))).toEqual(entry);
    expect(events).toContain("registered");
  });

  test("propagates register failure as thrown error", async () => {
    transport.stub("register_agent", async () => ({
      ok: false,
      error: { code: "PERMISSION", message: "unauthorized", retryable: false },
    }));
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await expect(registry.register(makeEntry("a1"))).rejects.toThrow(/unauthorized/);
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — list and lookup", () => {
  let transport: MockTransport;
  beforeEach(() => {
    transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    stubRegisterFlow(transport, "a2");
  });

  test("filters by phase", async () => {
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));
    await registry.register(
      makeEntry("a2", {
        status: {
          phase: "waiting",
          generation: 0,
          conditions: [],
          lastTransitionAt: 1,
        },
      }),
    );

    expect((await Promise.resolve(registry.list({ phase: "running" }))).length).toBe(1);
    expect((await Promise.resolve(registry.list({ phase: "waiting" }))).length).toBe(1);
    expect((await Promise.resolve(registry.list())).length).toBe(2);
    await registry[Symbol.asyncDispose]();
  });

  test("lookup returns undefined for unknown agent", async () => {
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    expect(registry.lookup(agentId("missing"))).toBeUndefined();
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — transition", () => {
  let transport: MockTransport;
  let registry: Awaited<ReturnType<typeof createNexusRegistry>>;

  beforeEach(async () => {
    transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));
  });

  test("CAS conflict on stale generation", async () => {
    const result = await registry.transition(agentId("a1"), "waiting", 99, { kind: "completed" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    await registry[Symbol.asyncDispose]();
  });

  test("rejects invalid transition edges", async () => {
    const result = await registry.transition(agentId("a1"), "created", 0, { kind: "completed" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    await registry[Symbol.asyncDispose]();
  });

  test("succeeds on valid transition with matching generation", async () => {
    const result = await registry.transition(agentId("a1"), "waiting", 0, {
      kind: "awaiting_response",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status.phase).toBe("waiting");
      expect(result.value.status.generation).toBe(1);
    }
    await registry[Symbol.asyncDispose]();
  });

  test("returns NOT_FOUND for unknown agent", async () => {
    const result = await registry.transition(agentId("missing"), "waiting", 0, {
      kind: "completed",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — patch", () => {
  test("updates priority and emits event", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    const events: string[] = [];
    registry.watch((e) => events.push(e.kind));

    const result = await registry.patch(agentId("a1"), { priority: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.priority).toBe(5);
    expect(events).toContain("patched");
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — deregister", () => {
  test("removes agent and emits event", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    transport.stub("delete_agent", async () => ({ ok: true, value: undefined }));

    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    const events: string[] = [];
    registry.watch((e) => events.push(e.kind));

    expect(await registry.deregister(agentId("a1"))).toBe(true);
    expect(registry.lookup(agentId("a1"))).toBeUndefined();
    expect(events).toContain("deregistered");
    await registry[Symbol.asyncDispose]();
  });

  test("returns false for unknown agent", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    expect(await registry.deregister(agentId("missing"))).toBe(false);
    await registry[Symbol.asyncDispose]();
  });

  test("preserves local state when Nexus delete fails", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    transport.stub("delete_agent", async () => ({
      ok: false,
      error: { code: "PERMISSION", message: "denied", retryable: false },
    }));
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    await expect(registry.deregister(agentId("a1"))).rejects.toThrow(/denied/);
    expect(registry.lookup(agentId("a1"))).toBeDefined();
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — transition partial failure", () => {
  test("reconciles local projection when metadata update fails after phase commit", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    // Phase transition still succeeds, but the follow-up metadata update fails
    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "metadata write failed", retryable: true },
    }));

    const result = await registry.transition(agentId("a1"), "waiting", 0, {
      kind: "awaiting_response",
    });
    expect(result.ok).toBe(false);
    // Local projection MUST reflect the new phase since Nexus already committed it
    const after = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(after?.status.phase).toBe("waiting");
    expect(after?.status.generation).toBe(1);
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — patch metadata merge", () => {
  test("merges fields.metadata with existing metadata locally", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1", { metadata: { existing: "keep", role: "worker" } }));

    const result = await registry.patch(agentId("a1"), {
      metadata: { added: "new", role: "captain" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metadata.existing).toBe("keep");
      expect(result.value.metadata.added).toBe("new");
      expect(result.value.metadata.role).toBe("captain");
    }
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — startup timeout", () => {
  test("aborts construction when warmup hangs", async () => {
    const transport = createMockTransport();
    transport.stub("list_agents", () => new Promise(() => {}));
    await expect(
      createNexusRegistry({ transport, pollIntervalMs: 0, startupTimeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("createNexusRegistry — register rollback", () => {
  test("deletes orphaned Nexus record when transition fails after register", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    transport.stub("register_agent", async () => ({
      ok: true,
      value: { agent_id: "a-orphan", state: "UNKNOWN", generation: 0 },
    }));
    transport.stub("agent_transition", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "transition failed", retryable: true },
    }));
    let deleteCalled = false;
    transport.stub("delete_agent", async () => {
      deleteCalled = true;
      return { ok: true, value: undefined };
    });

    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await expect(registry.register(makeEntry("a-orphan"))).rejects.toThrow(
      /transition to CONNECTED failed/,
    );
    expect(deleteCalled).toBe(true);
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — patch zoneId not supported", () => {
  test("returns VALIDATION error when zoneId is patched", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    type ZoneId = import("@koi/core").ZoneId;
    const result = await registry.patch(agentId("a1"), {
      zoneId: "z1" as unknown as ZoneId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/zone-move/);
    }
    await registry[Symbol.asyncDispose]();
  });
});

describe("mapNexusAgentToEntry — stale koi:status reconciliation", () => {
  test("ignores stale koi:status when phase disagrees with Nexus state", async () => {
    const transport = createMockTransport();
    // Nexus says CONNECTED (running), but metadata's koi:status still
    // claims phase: created. The mapper should trust Nexus over the
    // stale metadata and report phase: running.
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a-stale", state: "CONNECTED", generation: 5 }],
    }));
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a-stale",
        state: "CONNECTED",
        generation: 5,
        metadata: {
          "koi:status": {
            phase: "created",
            generation: 1,
            conditions: [],
            lastTransitionAt: 100,
          },
        },
      },
    }));

    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const entry = await Promise.resolve(registry.lookup(agentId("a-stale")));
    expect(entry?.status.phase).toBe("running");
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — watch unsubscribe", () => {
  test("unsubscribe stops further events", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });

    const events: string[] = [];
    const unsub = registry.watch((e) => events.push(e.kind));
    unsub();

    await registry.register(makeEntry("a1"));
    expect(events.length).toBe(0);
    await registry[Symbol.asyncDispose]();
  });
});
