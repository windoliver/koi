import { beforeEach, describe, expect, test } from "bun:test";
import { agentId, type RegistryEntry, zoneId } from "@koi/core";
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

  test("fails closed when Nexus returns an unknown AgentState during warmup", async () => {
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a1", state: "QUARANTINED", generation: 0 }],
    }));
    transport.stub("get_agent", async () => ({
      ok: true,
      value: { agent_id: "a1", state: "QUARANTINED", generation: 0, metadata: {} },
    }));
    await expect(createNexusRegistry({ transport, pollIntervalMs: 0 })).rejects.toThrow(
      /Unknown Nexus AgentState/,
    );
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

  test("preserves caller phase (created) on register so startup transitions can fire", async () => {
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const result = await registry.register(
      makeEntry("a1", {
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: 1 },
      }),
    );
    // The koi:status metadata blob carries the precise phase. Both
    // `created` and `running` round-trip through Nexus CONNECTED, so
    // mapNexusAgentToEntry trusts the blob and we keep `created` until
    // the runtime issues the real `created → running` transition. Without
    // this, ChildHandle would never observe a startup transition event.
    expect(result.status.phase).toBe("created");
    const stored = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(stored?.status.phase).toBe("created");
    await registry[Symbol.asyncDispose]();
  });

  test("preserves caller phase (idle) on register", async () => {
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const result = await registry.register(
      makeEntry("a1", {
        status: { phase: "idle", generation: 0, conditions: [], lastTransitionAt: 1 },
      }),
    );
    expect(result.status.phase).toBe("idle");
    await registry[Symbol.asyncDispose]();
  });

  test("persists config.zoneId into local projection when entry.zoneId is undefined", async () => {
    transport.stub("agent_list_by_zone", async () => ({ ok: true, value: [] }));
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({
      transport,
      pollIntervalMs: 0,
      zoneId: "zone-default",
    });
    await registry.register(makeEntry("a1"));
    const stored = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(stored?.zoneId).toBe(zoneId("zone-default"));
    await registry[Symbol.asyncDispose]();
  });

  test("strips caller-supplied reserved metadata keys on register", async () => {
    let registerMeta: Readonly<Record<string, unknown>> | undefined;
    transport.stub("register_agent", async (params) => {
      registerMeta = params.metadata as Readonly<Record<string, unknown>>;
      return { ok: true, value: { agent_id: "a1", state: "UNKNOWN", generation: 0 } };
    });
    transport.stub("agent_transition", async (params) => ({
      ok: true,
      value: {
        agent_id: "a1",
        state: params.target_state as string,
        generation: ((params.expected_generation as number) ?? 0) + 1,
      },
    }));
    transport.stub("update_agent_metadata", async () => ({
      ok: true,
      value: { agent_id: "a1", state: "CONNECTED", generation: 99 },
    }));

    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    // Adversarial caller tries to mark a non-terminated agent as terminated
    // via reserved metadata keys.
    await registry.register(
      makeEntry("a1", {
        metadata: {
          benign: "ok",
          "koi:terminated": true,
          "koi:status": {
            phase: "terminated",
            generation: 99,
            conditions: [],
            lastTransitionAt: 1,
          },
          agentType: "evil",
        },
      }),
    );
    expect(registerMeta?.benign).toBe("ok");
    // Reserved keys must come from the adapter, not the caller.
    expect(registerMeta?.["koi:terminated"]).toBe(false);
    const status = registerMeta?.["koi:status"] as Record<string, unknown> | undefined;
    expect(status?.phase).toBe("running"); // canonical, not the forged "terminated"
    expect(registerMeta?.agentType).toBe("worker");
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

describe("createNexusRegistry — tombstone self-heal", () => {
  test("poll forces hydration of stale entries even when generation is unchanged", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 5 });
    await registry.register(makeEntry("a1"));

    // Force tombstone via failing transition + failing reconcile.
    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "fail", retryable: true },
    }));
    let getMode: "fail" | "succeed" = "fail";
    transport.stub("get_agent", async () => {
      if (getMode === "fail") {
        return { ok: false, error: { code: "EXTERNAL", message: "fail", retryable: true } };
      }
      return {
        ok: true,
        value: {
          agent_id: "a1",
          state: "CONNECTED",
          generation: 1,
          metadata: { agentType: "worker", priority: 10, registeredAt: 1 },
        },
      };
    });

    await registry.transition(agentId("a1"), "waiting", 0, { kind: "awaiting_response" });
    expect(registry.lookup(agentId("a1"))).toBeUndefined();

    // Nexus is healthy now, but list_agents reports the same generation
    // as locally cached. Without the stale-set bypass, poll would never
    // re-hydrate this id.
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a1", state: "CONNECTED", generation: 1 }],
    }));
    getMode = "succeed";

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Stale flag cleared by successful refetch — entry visible again.
    expect(registry.lookup(agentId("a1"))).toBeDefined();
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — id reuse after tombstone", () => {
  test("re-registering a tombstoned id clears stale state and restores reads", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    // Force tombstone via failing transition + failing reconcile.
    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "fail", retryable: true },
    }));
    transport.stub("get_agent", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "fail", retryable: true },
    }));
    await registry.transition(agentId("a1"), "waiting", 0, { kind: "awaiting_response" });
    expect(registry.lookup(agentId("a1"))).toBeUndefined();

    // Deregister + re-register the same id. Must work despite tombstone.
    transport.stub("delete_agent", async () => ({ ok: true, value: undefined }));
    await registry.deregister(agentId("a1"));
    stubRegisterFlow(transport, "a1");
    await registry.register(makeEntry("a1"));

    const stored = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(stored).toBeDefined();
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

describe("createNexusRegistry — visibility passthrough", () => {
  test("list accepts VisibilityContext for AgentRegistry contract compatibility (enforcement is in createVisibilityFilter)", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    // Must not throw — registry-nexus is contractually compatible with
    // AgentRegistry.list(filter, visibility); permission scoping is the
    // job of createVisibilityFilter wrapping this layer.
    const listed = registry.list(undefined, { callerId: agentId("caller-1") });
    expect(Array.isArray(listed)).toBe(true);
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

describe("createNexusRegistry — patch ambiguous failure", () => {
  test("tombstones entry after bounded reconcile retries fail", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "transport timeout", retryable: true },
    }));
    transport.stub("get_agent", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "refetch failed", retryable: true },
    }));

    const result = await registry.patch(agentId("a1"), { metadata: { x: "y" } });
    expect(result.ok).toBe(false);
    // Reads blocked until refetch succeeds — caller cannot act on
    // potentially-divergent local mirror.
    expect(registry.lookup(agentId("a1"))).toBeUndefined();
    await registry[Symbol.asyncDispose]();
  });

  test("reconciles from refetch when metadata write commits but response is lost", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await registry.register(makeEntry("a1"));

    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "response lost", retryable: true },
    }));
    // Refetch reveals the patch was committed remotely.
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a1",
        state: "CONNECTED",
        generation: 5,
        metadata: {
          agentType: "worker",
          priority: 10,
          registeredAt: 1_700_000_000_000,
          x: "y",
        },
      },
    }));

    const result = await registry.patch(agentId("a1"), { metadata: { x: "y" } });
    expect(result.ok).toBe(false);
    // Entry visible; reflects committed remote state.
    const after = await Promise.resolve(registry.lookup(agentId("a1")));
    expect(after?.metadata.x).toBe("y");
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
  test("deletes orphaned Nexus record only when refetch confirms pre-transition state", async () => {
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
    // Refetch confirms agent is still UNKNOWN — safe to delete.
    transport.stub("get_agent", async () => ({
      ok: true,
      value: { agent_id: "a-orphan", state: "UNKNOWN", generation: 0, metadata: {} },
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

  test("skips destructive rollback when refetch shows transition committed despite RPC failure", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    transport.stub("register_agent", async () => ({
      ok: true,
      value: { agent_id: "ambiguous", state: "UNKNOWN", generation: 0 },
    }));
    transport.stub("agent_transition", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "transport timeout", retryable: true },
    }));
    // Refetch reveals agent IS in CONNECTED — the transition committed
    // before the response was lost. Deleting would destroy a live agent.
    transport.stub("get_agent", async () => ({
      ok: true,
      value: { agent_id: "ambiguous", state: "CONNECTED", generation: 1, metadata: {} },
    }));
    let deleteCalled = false;
    transport.stub("delete_agent", async () => {
      deleteCalled = true;
      return { ok: true, value: undefined };
    });

    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    await expect(registry.register(makeEntry("ambiguous"))).rejects.toThrow(
      /CONNECTED|refusing destructive rollback|skipped delete/,
    );
    expect(deleteCalled).toBe(false);
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

describe("createNexusRegistry — projection immutability", () => {
  test("returned entries are frozen so callers cannot mutate metadata in place", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const stored = await registry.register(makeEntry("a1"));

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.metadata)).toBe(true);
    expect(Object.isFrozen(stored.status)).toBe(true);

    // Attempted in-process injection of reserved key must throw in strict
    // mode (frozen object) rather than silently corrupt later patch payloads.
    expect(() => {
      (stored.metadata as Record<string, unknown>)["koi:terminated"] = true;
    }).toThrow();

    const looked = await registry.lookup(agentId("a1"));
    expect(looked).toBeDefined();
    if (looked !== undefined) {
      expect(Object.isFrozen(looked.metadata)).toBe(true);
      // Mutation attempt above must not have leaked into the projection.
      expect(looked.metadata["koi:terminated"]).not.toBe(true);
    }
    await registry[Symbol.asyncDispose]();
  });

  test("nested koi:status object is deep-frozen against in-place phase tampering", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const stored = await registry.register(makeEntry("a1"));

    const koiStatus = stored.metadata["koi:status"];
    expect(typeof koiStatus).toBe("object");
    expect(Object.isFrozen(koiStatus)).toBe(true);

    // Attempting to flip the nested phase via mutation must throw, not
    // silently land in `current.metadata` for the next transition()/patch()
    // outbound rebuild.
    expect(() => {
      (koiStatus as Record<string, unknown>).phase = "terminated";
    }).toThrow();
    await registry[Symbol.asyncDispose]();
  });
});

describe("createNexusRegistry — terminate ambiguous failure", () => {
  test("tombstones rather than reconciling when terminate metadata-write fails", async () => {
    const transport = createMockTransport();
    stubEmptyList(transport);
    stubRegisterFlow(transport, "a1");
    transport.stub("agent_transition", async () => ({
      ok: true,
      value: { agent_id: "a1", generation: 99 },
    }));
    transport.stub("update_agent_metadata", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "metadata write lost", retryable: true },
    }));
    // get_agent must not be consulted: refetching SUSPENDED without
    // koi:terminated would map back to "suspended" and silently downgrade.
    let getCalls = 0;
    transport.stub("get_agent", async () => {
      getCalls++;
      return {
        ok: true,
        value: { agent_id: "a1", state: "SUSPENDED", generation: 99, metadata: {} },
      };
    });

    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });
    const registered = await registry.register(makeEntry("a1"));
    const result = await registry.transition(
      agentId("a1"),
      "terminated",
      registered.status.generation,
      { kind: "completed" },
    );
    expect(result.ok).toBe(false);
    // Tombstoned: lookup must return undefined rather than report
    // "suspended" (which would happen if we reconciled from refetch).
    const looked = await registry.lookup(agentId("a1"));
    expect(looked).toBeUndefined();
    // No reconcile path was taken on the terminate ambiguous failure.
    expect(getCalls).toBe(0);
    await registry[Symbol.asyncDispose]();
  });
});

describe("mapNexusAgentToEntry — koi:status reconciliation", () => {
  test("trusts koi:status when it round-trips through the same Nexus state", async () => {
    const transport = createMockTransport();
    // Nexus says CONNECTED; both `created` and `running` round-trip there,
    // so a `koi:status.phase = created` blob must be trusted (otherwise
    // a freshly-registered child would be observable as `running` without
    // ever firing a `created → running` transition event).
    transport.stub("list_agents", async () => ({
      ok: true,
      value: [{ agent_id: "a-created", state: "CONNECTED", generation: 5 }],
    }));
    transport.stub("get_agent", async () => ({
      ok: true,
      value: {
        agent_id: "a-created",
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
    const entry = await Promise.resolve(registry.lookup(agentId("a-created")));
    expect(entry?.status.phase).toBe("created");
    await registry[Symbol.asyncDispose]();
  });

  test("ignores koi:status that doesn't round-trip to the live Nexus state", async () => {
    const transport = createMockTransport();
    // Nexus says CONNECTED but koi:status.phase = `suspended` (which would
    // round-trip to SUSPENDED). The blob is provably stale; trust the
    // live Nexus state and fall back to the default `running`.
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
            phase: "suspended",
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
