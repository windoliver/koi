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
    expect(sendGatewayFrame.mock.calls[0]).toEqual([
      "agent-1",
      { kind: "agent:text_delta", delta: "Hello ", sessionId: "session-1" },
    ]);
    expect(sendGatewayFrame.mock.calls[1]).toEqual([
      "agent-1",
      { kind: "agent:text_delta", delta: "world", sessionId: "session-1" },
    ]);
    expect(result.blocks).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world" },
    ]);
    expect(result.updatedStateRefs.turnsProcessed).toBe(1);
    expect(result.updatedStateRefs.lastTurnId).toContain("turn:");
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
      nexusApiKey: "nexus-a",
      delegationId: "delegation-a",
    });

    await runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m2", senderId: "u1", content: [], timestamp: Date.now() },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 1 },
      gatewayUrl: undefined,
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
});

describe("index re-exports", () => {
  test("createActivities is exported from the public entrypoint", () => {
    expect(createActivitiesFromIndex).toBe(createActivities);
  });
});
