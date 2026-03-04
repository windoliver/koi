import { afterEach, describe, expect, test } from "bun:test";
import type { AgentId, NameChangeEvent, NameServiceBackend } from "@koi/core";
import type { FetchFn, NexusNameServiceConfig } from "./config.js";
import { createNexusNameService } from "./nexus-name-service.js";
import type { NexusNameRecord } from "./nexus-rpc.js";

// ---------------------------------------------------------------------------
// Mock Nexus ANS server
// ---------------------------------------------------------------------------

interface MockAnsServer {
  readonly fetch: FetchFn;
  readonly records: Map<string, NexusNameRecord>;
}

function createMockAnsServer(initial?: readonly NexusNameRecord[]): MockAnsServer {
  const records = new Map<string, NexusNameRecord>();
  for (const r of initial ?? []) {
    records.set(`${r.scope}:${r.name}`, r);
  }

  const fetch: FetchFn = async (_input, init) => {
    const body =
      init?.body !== undefined
        ? (JSON.parse(init.body as string) as {
            readonly method: string;
            readonly params: Record<string, unknown>;
            readonly id: string;
          })
        : undefined;

    if (body === undefined) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid request" },
          id: "0",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const method = body.method;
    const params = body.params;

    // Route by method
    if (method === "name.list") {
      const zoneId = params.zone_id as string | undefined;
      const filtered = [...records.values()].filter(
        (r) => zoneId === undefined || r.zone_id === zoneId,
      );
      return jsonRpcOk(filtered, body.id);
    }

    if (method === "name.register") {
      const key = `${params.scope as string}:${params.name as string}`;
      if (records.has(key)) {
        return jsonRpcError(-32006, "Name already registered", body.id);
      }
      const now = Date.now();
      const ttlMs = params.ttl_ms as number | undefined;
      const record: NexusNameRecord = {
        name: params.name as string,
        binding_kind: params.binding_kind as "agent" | "brick",
        agent_id: params.agent_id as string | undefined,
        brick_id: params.brick_id as string | undefined,
        brick_kind: params.brick_kind as string | undefined,
        scope: params.scope as string,
        aliases: (params.aliases as readonly string[]) ?? [],
        registered_at: now,
        expires_at: ttlMs !== undefined && ttlMs > 0 ? now + ttlMs : 0,
        registered_by: params.registered_by as string,
        zone_id: params.zone_id as string | undefined,
      };
      records.set(key, record);
      return jsonRpcOk(record, body.id);
    }

    if (method === "name.deregister") {
      const key = `${params.scope as string}:${params.name as string}`;
      if (!records.has(key)) {
        return jsonRpcError(-32000, "Name not found", body.id);
      }
      records.delete(key);
      return jsonRpcOk({}, body.id);
    }

    if (method === "name.renew") {
      const key = `${params.scope as string}:${params.name as string}`;
      const existing = records.get(key);
      if (existing === undefined) {
        return jsonRpcError(-32000, "Name not found", body.id);
      }
      const ttlMs = params.ttl_ms as number | undefined;
      const now = Date.now();
      const renewed: NexusNameRecord = {
        ...existing,
        expires_at: ttlMs !== undefined && ttlMs > 0 ? now + ttlMs : 0,
      };
      records.set(key, renewed);
      return jsonRpcOk(renewed, body.id);
    }

    if (method === "name.resolve") {
      const name = params.name as string;
      const scope = params.scope as string | undefined;
      for (const r of records.values()) {
        if (r.name === name && (scope === undefined || r.scope === scope)) {
          return jsonRpcOk(r, body.id);
        }
      }
      return jsonRpcError(-32000, "Name not found", body.id);
    }

    return jsonRpcError(-32601, "Method not found", body.id);
  };

  return { fetch, records };
}

function jsonRpcOk(result: unknown, id: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result, id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(code: number, message: string, id: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

function makeConfig(server: MockAnsServer): NexusNameServiceConfig {
  return {
    baseUrl: "https://nexus.test",
    apiKey: "sk-test",
    fetch: server.fetch,
    pollIntervalMs: 0, // Disabled for unit tests
  };
}

describe("createNexusNameService", () => {
  let ns: NameServiceBackend;

  afterEach(() => {
    ns?.dispose?.();
  });

  // -----------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------

  test("starts with empty projection when Nexus has no records", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.resolve("nonexistent");
    expect(result.ok).toBe(false);
  });

  test("loads existing records from Nexus on startup", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.resolve("reviewer");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.name).toBe("reviewer");
    }
  });

  test("throws on Nexus startup failure", async () => {
    const fetchFn: FetchFn = async () => {
      return new Response(JSON.stringify({}), { status: 500, statusText: "Internal Server Error" });
    };
    const config: NexusNameServiceConfig = {
      baseUrl: "https://nexus.test",
      apiKey: "sk-test",
      fetch: fetchFn,
      pollIntervalMs: 0,
    };

    await expect(createNexusNameService(config)).rejects.toThrow("Failed to load names");
  });

  test("throws on invalid config", async () => {
    await expect(
      createNexusNameService({ baseUrl: "", apiKey: "sk-test", pollIntervalMs: 0 }),
    ).rejects.toThrow("Invalid NexusNameServiceConfig");
  });

  // -----------------------------------------------------------------------
  // Register
  // -----------------------------------------------------------------------

  test("registers a name via Nexus and updates local projection", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.register({
      name: "code-reviewer",
      binding: { kind: "agent", agentId: "agent-cr" as AgentId },
      scope: "global",
      aliases: ["cr"],
      registeredBy: "test",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("code-reviewer");
    }

    // Verify local resolution works immediately
    const resolved = await ns.resolve("code-reviewer");
    expect(resolved.ok).toBe(true);

    // Verify alias resolution
    const aliasResolved = await ns.resolve("cr");
    expect(aliasResolved.ok).toBe(true);
    if (aliasResolved.ok) {
      expect(aliasResolved.value.matchedAlias).toBe(true);
    }
  });

  test("register emits onChange event", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const events: NameChangeEvent[] = [];
    ns.onChange?.((e) => events.push(e));

    await ns.register({
      name: "reviewer",
      binding: { kind: "agent", agentId: "agent-1" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("registered");
    expect(events[0]?.name).toBe("reviewer");
  });

  test("register rejects invalid name locally (no RPC)", async () => {
    const server = createMockAnsServer();
    // Track RPC calls
    const originalFetch = server.fetch;
    let rpcCalls = 0;
    const trackingFetch: FetchFn = async (input, init) => {
      rpcCalls++;
      return originalFetch(input, init);
    };

    ns = await createNexusNameService({
      ...makeConfig(server),
      fetch: trackingFetch,
    });
    const startCalls = rpcCalls; // Startup makes one list call

    const result = await ns.register({
      name: "INVALID",
      binding: { kind: "agent", agentId: "agent-1" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
    // No additional RPC calls after startup
    expect(rpcCalls).toBe(startCalls);
  });

  test("register returns CONFLICT from Nexus", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.register({
      name: "reviewer",
      binding: { kind: "agent", agentId: "agent-2" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  test("register returns RATE_LIMIT at maxEntries", async () => {
    const server = createMockAnsServer([
      {
        name: "a",
        binding_kind: "agent",
        agent_id: "agent-a",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService({
      ...makeConfig(server),
      maxEntries: 1,
    });

    const result = await ns.register({
      name: "b",
      binding: { kind: "agent", agentId: "agent-b" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
    }
  });

  // -----------------------------------------------------------------------
  // Unregister
  // -----------------------------------------------------------------------

  test("unregisters a name via Nexus and updates local projection", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const removed = await ns.unregister("reviewer", "agent");
    expect(removed).toBe(true);

    const result = await ns.resolve("reviewer");
    expect(result.ok).toBe(false);
  });

  test("unregister returns false for non-existent name", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const removed = await ns.unregister("nonexistent", "agent");
    expect(removed).toBe(false);
  });

  test("unregister emits onChange event", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const events: NameChangeEvent[] = [];
    ns.onChange?.((e) => events.push(e));

    await ns.unregister("reviewer", "agent");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("unregistered");
  });

  // -----------------------------------------------------------------------
  // Renew
  // -----------------------------------------------------------------------

  test("renews a name via Nexus", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 2000,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.renew("reviewer", "agent", 60_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expiresAt).toBeGreaterThan(2000);
    }
  });

  test("renew returns NOT_FOUND for non-existent name", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.renew("nonexistent", "agent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("renew emits onChange event", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 2000,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const events: NameChangeEvent[] = [];
    ns.onChange?.((e) => events.push(e));

    await ns.renew("reviewer", "agent", 60_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("renewed");
  });

  // -----------------------------------------------------------------------
  // Resolve
  // -----------------------------------------------------------------------

  test("resolve returns NOT_FOUND for unknown name", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.resolve("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  test("search filters by scope", async () => {
    const server = createMockAnsServer([
      {
        name: "a",
        binding_kind: "agent",
        agent_id: "agent-a",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
      {
        name: "b",
        binding_kind: "agent",
        agent_id: "agent-b",
        scope: "global",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const results = await ns.search({ scope: "agent" });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("a");
  });

  // -----------------------------------------------------------------------
  // Suggest
  // -----------------------------------------------------------------------

  test("suggest returns fuzzy matches", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    const suggestions = await ns.suggest("reviewr");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.name).toBe("reviewer");
  });

  // -----------------------------------------------------------------------
  // Poll sync
  // -----------------------------------------------------------------------

  test("poll detects externally added record", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const events: NameChangeEvent[] = [];
    ns.onChange?.((e) => events.push(e));

    // Externally add a record to the mock server
    server.records.set("agent:new-agent", {
      name: "new-agent",
      binding_kind: "agent",
      agent_id: "agent-new",
      scope: "agent",
      aliases: [],
      registered_at: Date.now(),
      expires_at: 0,
      registered_by: "external",
    });

    // Manually trigger poll by creating a new service that picks up the change
    // (since poll is disabled in unit tests, we test via a fresh startup)
    ns.dispose?.();
    ns = await createNexusNameService(makeConfig(server));

    const result = await ns.resolve("new-agent");
    expect(result.ok).toBe(true);
  });

  test("poll detects externally removed record", async () => {
    const server = createMockAnsServer([
      {
        name: "temp",
        binding_kind: "agent",
        agent_id: "agent-temp",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));

    // Verify it's there
    expect((await ns.resolve("temp")).ok).toBe(true);

    // Remove from server
    server.records.delete("agent:temp");

    // Re-create to simulate poll
    ns.dispose?.();
    ns = await createNexusNameService(makeConfig(server));

    expect((await ns.resolve("temp")).ok).toBe(false);
  });

  // -----------------------------------------------------------------------
  // onChange / unsubscribe
  // -----------------------------------------------------------------------

  test("onChange listener can be unsubscribed", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const events: NameChangeEvent[] = [];
    const unsub = ns.onChange?.((e) => events.push(e));

    await ns.register({
      name: "a",
      binding: { kind: "agent", agentId: "agent-a" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });
    expect(events).toHaveLength(1);

    // Unsubscribe
    unsub?.();

    await ns.register({
      name: "b",
      binding: { kind: "agent", agentId: "agent-b" as AgentId },
      scope: "global",
      registeredBy: "test",
    });
    // No new event
    expect(events).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Dispose
  // -----------------------------------------------------------------------

  test("dispose clears state and stops operations", async () => {
    const server = createMockAnsServer([
      {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
        aliases: [],
        registered_at: 1000,
        expires_at: 0,
        registered_by: "test",
      },
    ]);
    ns = await createNexusNameService(makeConfig(server));
    ns.dispose?.();

    const result = await ns.resolve("reviewer");
    expect(result.ok).toBe(false);
  });

  test("no events emitted after dispose", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService(makeConfig(server));

    const events: NameChangeEvent[] = [];
    ns.onChange?.((e) => events.push(e));

    ns.dispose?.();

    // Register should fail silently on disposed backend
    // (the register call goes to Nexus, but local state is cleared)
    await ns.register({
      name: "a",
      binding: { kind: "agent", agentId: "agent-a" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });
    // Listeners were cleared on dispose
    expect(events).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Poll interval
  // -----------------------------------------------------------------------

  test("pollIntervalMs: 0 disables poll", async () => {
    const server = createMockAnsServer();
    ns = await createNexusNameService({
      ...makeConfig(server),
      pollIntervalMs: 0,
    });

    // Just verify it doesn't crash — poll timer should not be set
    expect(ns).toBeDefined();
  });
});
