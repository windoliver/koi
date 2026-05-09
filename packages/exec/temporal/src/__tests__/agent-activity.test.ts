import { describe, expect, mock, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type { ActivityDeps } from "../activities/agent-activity.js";
import { createActivities } from "../activities/agent-activity.js";
import { createActivities as createActivitiesFromIndex } from "../index.js";

describe("createActivities", () => {
  test("collects text deltas and streams them to the gateway", async () => {
    const sendGatewayFrame = mock<ActivityDeps["sendGatewayFrame"]>(async () => {});
    const getCreateKoiOptions = mock<ActivityDeps["getCreateKoiOptions"]>(async () => ({
      manifest: {},
      adapter: {},
    }));
    const getOrCreate = mock<ActivityDeps["engineCache"]["getOrCreate"]>(async () => ({
      run: async function* () {
        yield { kind: "text_delta", delta: "Hello " };
        yield { kind: "text_delta", delta: "world" };
      },
    }));
    const createEngineInput = mock(() => ({ kind: "text", text: "hi" }) as const);

    const { runAgentTurn } = createActivities({
      engineCache: { getOrCreate },
      sendGatewayFrame,
      createEngineInput,
      getCreateKoiOptions,
      computeCacheKey: (input) => ({
        manifestHash: "m",
        forgeGeneration: 1,
        credentialScope: `${input.delegationId ?? ""}|${input.nexusApiKey ?? ""}`,
      }),
    });

    const result = await runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      gatewayUrl: "ws://gateway",
      turnId: "test-turn",
    });

    expect(createEngineInput).toHaveBeenCalledTimes(1);
    expect(getOrCreate).toHaveBeenCalledTimes(1);
    expect(getCreateKoiOptions).toHaveBeenCalledTimes(1);
    expect(getCreateKoiOptions.mock.calls[0]?.[0]).toEqual({
      agentId: "agent-1" as AgentId,
      delegationId: undefined,
      nexusApiKey: undefined,
    });
    expect(sendGatewayFrame).toHaveBeenCalledTimes(2);
    expect(sendGatewayFrame.mock.calls[0]?.[0]).toBe("agent-1");
    expect(sendGatewayFrame.mock.calls[0]?.[1]).toMatchObject({
      kind: "agent:text_delta",
      delta: "Hello ",
      sessionId: "session-1",
      frameIndex: 0,
    });
    expect(sendGatewayFrame.mock.calls[1]?.[0]).toBe("agent-1");
    expect(sendGatewayFrame.mock.calls[1]?.[1]).toMatchObject({
      kind: "agent:text_delta",
      delta: "world",
      sessionId: "session-1",
      frameIndex: 1,
    });
    expect(result.blocks).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world" },
    ]);
    expect(result.updatedStateRefs.turnsProcessed).toBe(1);
    expect(result.updatedStateRefs.lastTurnId).toBe("test-turn");
  });

  test("captures spawn_requested and returns spawnChild", async () => {
    const { runAgentTurn } = createActivities({
      engineCache: {
        getOrCreate: async () => ({
          run: async function* () {
            yield {
              kind: "spawn_requested",
              childAgentId: "child-1",
            };
          },
        }),
      },
      sendGatewayFrame: async () => {},
      createEngineInput: () => ({ kind: "text", text: "hi" }),
      computeCacheKey: (input) => ({
        manifestHash: "m",
        forgeGeneration: 1,
        credentialScope: `${input.delegationId ?? ""}|${input.nexusApiKey ?? ""}`,
      }),
      getCreateKoiOptions: async () => ({ manifest: {}, adapter: {} }),
    });

    const result = await runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 1 },
      gatewayUrl: undefined,
      turnId: "test-turn",
    });

    expect(result.spawnChild).toEqual({
      childAgentId: "child-1" as AgentId,
      childConfig: {
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      },
    });
  });

  test("maps runtime failures into ApplicationFailure", async () => {
    const { runAgentTurn } = createActivities({
      engineCache: {
        getOrCreate: async () => ({
          run: async function* () {
            yield { kind: "turn_start" };
            throw new Error("boom");
          },
        }),
      },
      sendGatewayFrame: async () => {},
      createEngineInput: () => ({ kind: "text", text: "hi" }),
      computeCacheKey: (input) => ({
        manifestHash: "m",
        forgeGeneration: 1,
        credentialScope: `${input.delegationId ?? ""}|${input.nexusApiKey ?? ""}`,
      }),
      getCreateKoiOptions: async () => ({ manifest: {}, adapter: {} }),
    });

    await expect(
      runAgentTurn({
        agentId: "agent-1" as never,
        sessionId: "session-1" as never,
        message: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
        gatewayUrl: undefined,
        turnId: "test-turn",
      }),
    ).rejects.toMatchObject({
      name: "ApplicationFailure",
      message: "boom",
    });
  });

  test("does not mutate process.env for nexus credentials", async () => {
    const previous = process.env.NEXUS_API_KEY;
    process.env.NEXUS_API_KEY = "outer-sentinel";

    const getCreateKoiOptions = mock<ActivityDeps["getCreateKoiOptions"]>(async () => ({
      manifest: {},
      adapter: {},
    }));
    const { runAgentTurn } = createActivities({
      engineCache: {
        getOrCreate: async () => ({
          run: async function* () {
            yield { kind: "done" };
          },
        }),
      },
      sendGatewayFrame: async () => {},
      createEngineInput: () => ({ kind: "text", text: "hi" }),
      computeCacheKey: (input) => ({
        manifestHash: "m",
        forgeGeneration: 1,
        credentialScope: `${input.delegationId ?? ""}|${input.nexusApiKey ?? ""}`,
      }),
      getCreateKoiOptions,
    });

    try {
      await runAgentTurn({
        agentId: "agent-1" as never,
        sessionId: "session-1" as never,
        message: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
        gatewayUrl: undefined,
        turnId: "test-turn",
        nexusApiKey: "per-turn-secret",
      });

      expect(process.env.NEXUS_API_KEY).toBe("outer-sentinel");
      expect(getCreateKoiOptions.mock.calls[0]?.[0]).toEqual({
        agentId: "agent-1" as AgentId,
        delegationId: undefined,
        nexusApiKey: "per-turn-secret",
      });
    } finally {
      if (previous !== undefined) {
        process.env.NEXUS_API_KEY = previous;
      } else {
        delete process.env.NEXUS_API_KEY;
      }
    }
  });

  test("uses credential-aware cache keys for distinct per-turn identity scope", async () => {
    const getOrCreate = mock<ActivityDeps["engineCache"]["getOrCreate"]>(async () => ({
      run: async function* () {
        yield { kind: "done" };
      },
    }));
    const computeCacheKey = mock(
      (input: {
        readonly agentId: string;
        readonly delegationId: string | undefined;
        readonly nexusApiKey: string | undefined;
      }) => ({
        manifestHash: "m",
        forgeGeneration: 1,
        credentialScope: `${input.delegationId ?? ""}|${input.nexusApiKey ?? ""}`,
      }),
    );

    const { runAgentTurn } = createActivities({
      engineCache: { getOrCreate },
      sendGatewayFrame: async () => {},
      createEngineInput: () => ({ kind: "text", text: "hi" }),
      computeCacheKey,
      getCreateKoiOptions: async () => ({ manifest: {}, adapter: {} }),
    });

    await runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      gatewayUrl: undefined,
      turnId: "test-turn",
      nexusApiKey: "nexus-a",
      delegationId: "delegation-a",
    });

    await runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m2", senderId: "u1", content: [], timestamp: Date.now() },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 1 },
      gatewayUrl: undefined,
      turnId: "test-turn",
      nexusApiKey: "nexus-b",
      delegationId: "delegation-b",
    });

    expect(computeCacheKey).toHaveBeenCalledTimes(2);
    expect(computeCacheKey.mock.calls[0]?.[0]).toEqual({
      agentId: "agent-1",
      delegationId: "delegation-a",
      nexusApiKey: "nexus-a",
    });
    expect(computeCacheKey.mock.calls[1]?.[0]).toEqual({
      agentId: "agent-1",
      delegationId: "delegation-b",
      nexusApiKey: "nexus-b",
    });
    expect(getOrCreate.mock.calls[0]?.[0]).toEqual({
      manifestHash: "m",
      forgeGeneration: 1,
      credentialScope: "delegation-a|nexus-a",
    });
    expect(getOrCreate.mock.calls[1]?.[0]).toEqual({
      manifestHash: "m",
      forgeGeneration: 1,
      credentialScope: "delegation-b|nexus-b",
    });
    expect(getOrCreate.mock.calls[0]?.[0]).not.toEqual(getOrCreate.mock.calls[1]?.[0]);
  });

  // ---------- Spawn validation corner cases ----------

  const baseDeps = (
    runFn: () => AsyncIterable<unknown>,
    sendGatewayFrame?: ActivityDeps["sendGatewayFrame"],
  ) => ({
    engineCache: {
      getOrCreate: async () => ({ run: () => runFn() }),
    },
    sendGatewayFrame: sendGatewayFrame ?? (async () => {}),
    createEngineInput: () => ({ kind: "text", text: "hi" }) as const,
    computeCacheKey: () => ({ manifestHash: "m", forgeGeneration: 1, credentialScope: "" }),
    getCreateKoiOptions: async () => ({ manifest: {}, adapter: {} }),
  });

  const callTurn = async (
    deps: ReturnType<typeof baseDeps>,
    overrides: Partial<Parameters<ReturnType<typeof createActivities>["runAgentTurn"]>[0]> = {},
    // biome-ignore lint/suspicious/noExplicitAny: test ergonomics
  ): Promise<any> => {
    const { runAgentTurn } = createActivities(deps);
    return runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m1", senderId: "u1", content: [], timestamp: 0 },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      gatewayUrl: undefined,
      turnId: "t1",
      ...overrides,
    });
  };

  test("additionalTools: [] is accepted (no-op)", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", additionalTools: [] },
        };
      }),
    );
    expect(result.spawnChild?.childAgentId).toBe("child-1");
    expect(result.droppedSpawns).toBeUndefined();
  });

  test("additionalTools: [{...}] is dropped with observable signal", async () => {
    const sendGatewayFrame = mock<ActivityDeps["sendGatewayFrame"]>(async () => {});
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", additionalTools: [{ name: "tool" }] },
        };
      }, sendGatewayFrame),
    );
    expect(result.spawnChild).toBeUndefined();
    expect(result.droppedSpawns).toEqual([
      { childAgentId: "child-1", reason: "unsupported-spawn-field:additionalTools" },
    ]);
    expect(sendGatewayFrame.mock.calls[0]?.[1]).toMatchObject({
      kind: "agent:spawn_dropped",
      reason: "unsupported-spawn-field:additionalTools",
    });
  });

  test("outputSchema is dropped (structured-output not supported on Temporal path)", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", outputSchema: { type: "object" } },
        };
      }),
    );
    expect(result.spawnChild).toBeUndefined();
    expect(result.droppedSpawns?.[0]?.reason).toBe("unsupported-spawn-field:outputSchema");
  });

  test("text_delta before unsupported spawn streams cleanly, no throw", async () => {
    const sendGatewayFrame = mock<ActivityDeps["sendGatewayFrame"]>(async () => {});
    const result = await callTurn(
      baseDeps(async function* () {
        yield { kind: "text_delta", delta: "hello " };
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", manifest: { id: "y" } },
        };
      }, sendGatewayFrame),
      { gatewayUrl: "ws://gw" },
    );
    expect(result.blocks).toEqual([{ kind: "text", text: "hello " }]);
    expect(result.droppedSpawns?.[0]?.reason).toBe("unsupported-spawn-field:manifest");
    expect(sendGatewayFrame.mock.calls[0]?.[1]?.kind).toBe("agent:text_delta");
    expect(sendGatewayFrame.mock.calls[1]?.[1]?.kind).toBe("agent:spawn_dropped");
  });

  test("timeoutMs: 0 disables deadline (no absoluteDeadlineMs synthesized)", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", timeoutMs: 0 },
        };
      }),
    );
    expect(result.spawnChild?.childConfig.absoluteDeadlineMs).toBeUndefined();
  });

  test("timeoutMs > 0 snapshots absoluteDeadlineMs at capture time", async () => {
    const before = Date.now();
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", timeoutMs: 5000 },
        };
      }),
    );
    const captured = result.spawnChild?.childConfig.absoluteDeadlineMs as number;
    expect(captured).toBeGreaterThanOrEqual(before + 5000);
    expect(captured).toBeLessThanOrEqual(Date.now() + 5000);
  });

  test("absoluteDeadlineMs wins over timeoutMs", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", timeoutMs: 5000, absoluteDeadlineMs: 9999 },
        };
      }),
    );
    expect(result.spawnChild?.childConfig.absoluteDeadlineMs).toBe(9999);
  });

  test("spawn context with Date is rejected (deep JSON validation)", async () => {
    await expect(
      callTurn(
        baseDeps(async function* () {
          yield {
            kind: "spawn_requested",
            childAgentId: "child-1",
            request: { description: "x", context: { when: new Date() } },
          };
        }),
      ),
    ).rejects.toMatchObject({ name: "ApplicationFailure" });
  });

  test("allowSpawn: false drops spawn with scheduled-firing reason", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x" },
        };
      }),
      { allowSpawn: false },
    );
    expect(result.spawnChild).toBeUndefined();
    expect(result.droppedSpawns).toEqual([
      { childAgentId: "child-1", reason: "scheduled-firing-no-spawn" },
    ]);
  });

  test("parent credentials are NOT propagated to spawned child", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x" },
        };
      }),
      {
        nexusApiKey: "parent-secret" as never,
        delegationId: "parent-deleg" as never,
      },
    );
    expect(result.spawnChild?.childConfig.nexusApiKey).toBeUndefined();
    expect(result.spawnChild?.childConfig.delegationId).toBeUndefined();
  });

  test("agentName and taskIndex are accepted (correlation-only, ignored)", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: {
            description: "x",
            agentName: "researcher",
            taskIndex: 3,
            taskId: "task-9",
          },
        };
      }),
    );
    expect(result.spawnChild?.childAgentId).toBe("child-1");
    expect(result.droppedSpawns).toBeUndefined();
  });

  test("multiple drops in one turn are all recorded", async () => {
    const result = await callTurn(
      baseDeps(async function* () {
        yield {
          kind: "spawn_requested",
          childAgentId: "child-1",
          request: { description: "x", outputSchema: {} },
        };
        yield {
          kind: "spawn_requested",
          childAgentId: "child-2",
          request: { description: "y", manifest: { id: "z" } },
        };
      }),
    );
    expect(result.droppedSpawns).toHaveLength(2);
    expect(result.droppedSpawns?.[0]?.childAgentId).toBe("child-1");
    expect(result.droppedSpawns?.[1]?.childAgentId).toBe("child-2");
  });
});

describe("index re-exports", () => {
  test("createActivities is exported from the public entrypoint", () => {
    expect(createActivitiesFromIndex).toBe(createActivities);
  });
});
