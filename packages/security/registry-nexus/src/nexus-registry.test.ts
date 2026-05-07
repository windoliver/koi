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

  test("fails closed when get_agent fails during warmup hydration", async () => {
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a1", state: "CONNECTED", generation: 0 }],
    }));
    transport.stub("get_agent", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "hydrate failed", retryable: true },
    }));
    await expect(createNexusRegistry({ transport, pollIntervalMs: 0 })).rejects.toThrow(/hydrate/);
  });

  test("fails closed when remote agent count exceeds maxEntries during warmup", async () => {
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [
        { agent_id: "a1", state: "CONNECTED", generation: 0 },
        { agent_id: "a2", state: "CONNECTED", generation: 0 },
        { agent_id: "a3", state: "CONNECTED", generation: 0 },
      ],
    }));
    await expect(
      createNexusRegistry({ transport, pollIntervalMs: 0, maxEntries: 2 }),
    ).rejects.toThrow(/maxEntries/);
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
    const stored = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(stored?.agentId).toBe(agentId("a1"));
    // Stored entry mirrors the merged outbound blob, including lifecycle
    // and identity markers — this lets patch() round-trip without dropping
    // koi:status, agentType, registeredAt, etc.
    expect(stored?.metadata["koi:status"]).toBeDefined();
    expect(stored?.metadata.agentType).toBe("worker");
    expect(events).toContain("registered");
  });

  test("canonicalizes lossy phases (created → running) on register", async () => {
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const result = await registry.register(
      makeEntry("a1", {
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: 1 },
      }),
    );
    // "created" maps to Nexus CONNECTED, which maps back to "running".
    // Storing the original "created" phase would leave the mirror
    // permanently disagreeing with Nexus.
    expect(result.status.phase).toBe("running");
    const stored = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(stored?.status.phase).toBe("running");
    await registry[Symbol.asyncDispose]();
  });

  test("canonicalizes lossy phases (idle → waiting) on register", async () => {
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const result = await registry.register(
      makeEntry("a1", {
        status: { phase: "idle", generation: 0, conditions: [], lastTransitionAt: 1 },
      }),
    );
    expect(result.status.phase).toBe("waiting");
    await registry[Symbol.asyncDispose]();
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
  test("refetches and reconciles from Nexus when metadata update fails after phase commit", async () => {
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
    // Refetch returns Nexus's authoritative post-transition state. Metadata
    // still carries the OLD koi:status (phase: running) since the metadata
    // write failed — reconciler must distrust it and fall back to live state.
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a1",
        state: "IDLE",
        generation: 1,
        metadata: {
          agentType: "worker",
          priority: 10,
          registeredAt: 1_700_000_000_000,
          "koi:status": {
            phase: "running",
            generation: 0,
            conditions: [],
            lastTransitionAt: 1_700_000_000_000,
          },
        },
      },
    }));

    const result = await registry.transition(agentId("a1"), "waiting", 0, {
      kind: "awaiting_response",
    });
    expect(result.ok).toBe(false);
    // Reconciler should reflect the live Nexus state (IDLE → waiting) and
    // distrust the stale koi:status blob (which still says "running").
    const after = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(after?.status.phase).toBe("waiting");
    await registry[Symbol.asyncDispose]();
  });

  test("tombstones entry when bounded reconcile retries all fail (lookup blocked, transition rejected)", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "metadata write failed", retryable: true },
    }));
    transport.stub("get_agent", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "refetch failed", retryable: true },
    }));

    const result = await registry.transition(agentId("a1"), "waiting", 0, {
      kind: "awaiting_response",
    });
    expect(result.ok).toBe(false);

    // Reads are blocked — phase-based scheduling must not act on known-
    // stale state.
    expect(registry.lookup(agentId("a1"))).toBeUndefined();
    const listed = await Promise.resolve(registry.list());
    expect(listed.length).toBe(0);

    // Mutating ops fail closed with a retryable error.
    const retryT = await registry.transition(agentId("a1"), "running", 1, { kind: "completed" });
    expect(retryT.ok).toBe(false);
    if (!retryT.ok) {
      expect(retryT.error.message).toContain("tombstoned");
      expect(retryT.error.retryable).toBe(true);
    }
    await registry[Symbol.asyncDispose]();
  });

  test("recovers via bounded retry when first refetch fails but second succeeds", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "metadata write failed", retryable: true },
    }));
    let getCalls = 0;
    transport.stub("get_agent", async () => {
      getCalls += 1;
      if (getCalls === 1) {
        return { ok: false, error: { code: "EXTERNAL", message: "blip", retryable: true } };
      }
      return {
        ok: true,
        value: {
          agent_id: "a1",
          state: "IDLE",
          generation: 1,
          metadata: {
            agentType: "worker",
            registeredAt: 1_700_000_000_000,
            priority: 10,
          },
        },
      };
    });

    const result = await registry.transition(agentId("a1"), "waiting", 0, {
      kind: "awaiting_response",
    });
    expect(result.ok).toBe(false);
    expect(getCalls).toBeGreaterThanOrEqual(2);
    const after = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(after?.status.phase).toBe("waiting");
    await registry[Symbol.asyncDispose]();
  });

  test("treats SUSPENDED without koi:terminated as suspended (not terminated)", async () => {
    const transport = createMockTransport();
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a1", state: "SUSPENDED", generation: 5 }],
    }));
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a1",
        state: "SUSPENDED",
        generation: 5,
        // Stale koi:status claims terminated, but no koi:terminated flag —
        // ambiguous, so reconciler must distrust it.
        metadata: {
          "koi:status": {
            phase: "terminated",
            generation: 9,
            conditions: [],
            lastTransitionAt: 1,
          },
        },
      },
    }));
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const entry = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(entry?.status.phase).toBe("suspended");
    await registry[Symbol.asyncDispose]();
  });

  test("trusts SUSPENDED + koi:terminated=true as terminated", async () => {
    const transport = createMockTransport();
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a1", state: "SUSPENDED", generation: 5 }],
    }));
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a1",
        state: "SUSPENDED",
        generation: 5,
        metadata: {
          "koi:terminated": true,
          "koi:status": {
            phase: "terminated",
            generation: 9,
            conditions: [],
            lastTransitionAt: 1,
          },
        },
      },
    }));
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const entry = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(entry?.status.phase).toBe("terminated");
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — capacity", () => {
  test("poll marks registry broken when remote overflow is observed", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({
      transport,
      pollIntervalMs: 5,
      maxEntries: 1,
    });
    await registry.register(makeEntry("a1"));

    // After registration completes, swap list_agents to surface a second
    // remote agent. Poll should detect overflow, set the broken flag, and
    // stop the timer rather than serve a partial mirror.
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [
        { agent_id: "a1", state: "CONNECTED", generation: 0 },
        { agent_id: "a2", state: "CONNECTED", generation: 0 },
      ],
    }));
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a2",
        state: "CONNECTED",
        generation: 0,
        metadata: {},
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(() => registry.list()).toThrow(/broken/);
    expect(() => registry.lookup(agentId("a1"))).toThrow(/broken/);
    await registry[Symbol.asyncDispose]();
  });

  test("repeated per-agent get_agent failures tombstone the affected entry", async () => {
    const transport = createMockTransport();
    // Two agents listed: one will hydrate cleanly, the other will keep
    // failing. Mixed-success ticks must tombstone only the broken one
    // without tripping registry-wide broken state.
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [
        { agent_id: "good", state: "CONNECTED", generation: 0 },
        { agent_id: "bad", state: "CONNECTED", generation: 0 },
      ],
    }));
    // Warmup hydrates both successfully.
    let warmedUp = false;
    transport.stub("get_agent", async (params) => {
      const ok = {
        ok: true as const,
        value: {
          agent_id: params.agent_id as string,
          state: "CONNECTED",
          generation: 0,
          metadata: { agentType: "worker", priority: 10, registeredAt: 1 },
        },
      };
      if (!warmedUp) return ok;
      if (params.agent_id === "good") return ok;
      return { ok: false, error: { code: "EXTERNAL", message: "transient", retryable: true } };
    });

    const registry = await createNexusRegistry({ transport, pollIntervalMs: 5 });
    warmedUp = true;
    expect(registry.lookup(agentId("good"))).toBeDefined();
    expect(registry.lookup(agentId("bad"))).toBeDefined();

    // Bump generations so poll() re-hydrates each tick.
    let gen = 1;
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [
        { agent_id: "good", state: "CONNECTED", generation: gen++ },
        { agent_id: "bad", state: "CONNECTED", generation: gen++ },
      ],
    }));

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Bad entry tombstoned; good entry still served.
    expect(registry.lookup(agentId("bad"))).toBeUndefined();
    expect(registry.lookup(agentId("good"))).toBeDefined();
    await registry[Symbol.asyncDispose]();
  });

  test("repeated poll list_agents failures mark registry broken", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 5 });

    // Make every subsequent list_agents fail
    transport.stub("list_agents", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "transport down", retryable: true },
    }));

    // Wait long enough for >5 poll ticks at 5ms cadence
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(() => registry.list()).toThrow(/broken|consecutive/);
    await registry[Symbol.asyncDispose]();
  });

  test("register fails closed when projection is at capacity", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({
      transport,
      pollIntervalMs: 0,
      maxEntries: 1,
    });
    await registry.register(makeEntry("a1"));

    stubRegisterFlow(transport, "a2");
    await expect(registry.register(makeEntry("a2"))).rejects.toThrow(/capacity/);
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — reserved metadata keys", () => {
  test("rejects patch that overwrites adapter-owned keys", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    for (const key of [
      "koi:status",
      "koi:terminated",
      "agentType",
      "registeredAt",
      "parentId",
      "spawner",
      "groupId",
    ]) {
      const result = await registry.patch(agentId("a1"), { metadata: { [key]: "evil" } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain(key);
      }
    }
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — visibility fail-closed", () => {
  test("list throws when VisibilityContext is supplied", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    expect(() => registry.list(undefined, { callerId: agentId("caller-1") })).toThrow(
      /createVisibilityFilter/,
    );
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — patch priority sync", () => {
  test("priority patch updates local metadata mirror to match Nexus payload", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    let lastPriority: unknown;
    transport.stub("update_agent_metadata", async (params) => {
      lastPriority = (params.metadata as Record<string, unknown>).priority;
      return { ok: true, value: { agent_id: "a1", state: "CONNECTED", generation: 5 } };
    });

    const result = await registry.patch(agentId("a1"), { priority: 42 });
    expect(result.ok).toBe(true);
    expect(lastPriority).toBe(42);
    if (result.ok) {
      expect(result.value.priority).toBe(42);
      // Local metadata mirror must also reflect the patched priority.
      expect(result.value.metadata.priority).toBe(42);
    }
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — metadata CAS", () => {
  test("transition update_agent_metadata includes expected_generation for CAS", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    let lastExpected: unknown;
    transport.stub("update_agent_metadata", async (params) => {
      lastExpected = params.expected_generation;
      return { ok: true, value: { agent_id: "a1", state: "IDLE", generation: 7 } };
    });

    await registry.transition(agentId("a1"), "waiting", 0, { kind: "awaiting_response" });
    expect(lastExpected).toBeDefined();
    expect(typeof lastExpected).toBe("number");
    await registry[Symbol.asyncDispose]();
  });

  test("patch update_agent_metadata includes expected_generation for CAS", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    let lastExpected: unknown;
    transport.stub("update_agent_metadata", async (params) => {
      lastExpected = params.expected_generation;
      return { ok: true, value: { agent_id: "a1", state: "CONNECTED", generation: 8 } };
    });

    await registry.patch(agentId("a1"), { metadata: { added: "x" } });
    expect(lastExpected).toBeDefined();
    expect(typeof lastExpected).toBe("number");
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

  test("patch outbound metadata preserves lifecycle markers from register", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1", { parentId: agentId("p1") }));

    // Capture what patch() sends to update_agent_metadata
    let patchedMetadata: Readonly<Record<string, unknown>> | undefined;
    transport.stub("update_agent_metadata", async (params) => {
      patchedMetadata = params.metadata as Readonly<Record<string, unknown>>;
      return { ok: true, value: { agent_id: "a1", state: "CONNECTED", generation: 100 } };
    });

    const result = await registry.patch(agentId("a1"), { metadata: { added: "new" } });
    expect(result.ok).toBe(true);
    expect(patchedMetadata).toBeDefined();
    // The outbound blob must include lifecycle and identity markers, not
    // just the user's patch payload.
    expect(patchedMetadata?.["koi:status"]).toBeDefined();
    expect(patchedMetadata?.agentType).toBe("worker");
    expect(patchedMetadata?.parentId).toBe("p1");
    expect(patchedMetadata?.added).toBe("new");
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
