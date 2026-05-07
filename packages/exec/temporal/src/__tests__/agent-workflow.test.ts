import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  MESSAGE_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
} from "../workflows/signals.js";
import type {
  AgentStateRefs,
  AgentTurnInput,
  AgentTurnResult,
  AgentWorkflowConfig,
  IncomingMessage,
  WorkerWorkflowConfig,
} from "../types.js";

const WORKFLOW_MODULE_PATH = new URL("../workflows/agent-workflow.ts", import.meta.url).href;

afterEach(() => {
  mock.restore();
});

describe("agent workflow module", () => {
  test("shared signal/query constants stay stable", () => {
    expect(MESSAGE_SIGNAL_NAME).toBe("message");
    expect(SHUTDOWN_SIGNAL_NAME).toBe("shutdown");
    expect(STATE_QUERY_NAME).toBe("getState");
    expect(STATUS_QUERY_NAME).toBe("getStatus");
    expect(PENDING_COUNT_QUERY_NAME).toBe("getPendingCount");
  });

  test("executes agent and worker workflows with gateway forwarding and scoped child ids", async () => {
    const defineSignalCalls: string[] = [];
    const defineQueryCalls: string[] = [];
    const proxyActivitiesCalls: unknown[] = [];
    const handlers = new Map<string, (...args: any[]) => any>();
    const startChildCalls: Array<{ workflowType: string; options: Record<string, unknown> }> = [];
    const stateSnapshots: AgentStateRefs[] = [];
    let currentStatus = "uninitialized";
    let pendingDuringTurn = -1;

    const initialMessage: IncomingMessage = {
      id: "msg-initial",
      senderId: "user-1",
      content: [],
      timestamp: 1,
    };
    const liveMessage: IncomingMessage = {
      id: "msg-live",
      senderId: "user-2",
      content: [],
      timestamp: 2,
    };

    const runAgentTurn = mock(async (input: AgentTurnInput): Promise<AgentTurnResult> => {
      if (input.agentId === ("agent-1" as AgentTurnInput["agentId"])) {
        stateSnapshots.push(input.stateRefs);
        currentStatus = handlers.get(STATUS_QUERY_NAME)?.();
        handlers.get(MESSAGE_SIGNAL_NAME)?.(liveMessage);
        pendingDuringTurn = handlers.get(PENDING_COUNT_QUERY_NAME)?.();
        handlers.get(SHUTDOWN_SIGNAL_NAME)?.({ reason: "operator-requested" });

        return {
          turnId: "turn-1",
          blocks: [],
          updatedStateRefs: {
            lastTurnId: "turn-1",
            turnsProcessed: input.stateRefs.turnsProcessed + 1,
          },
          spawnChild: {
            childAgentId: "child-1" as AgentTurnResult["spawnChild"] extends infer T
              ? T extends { childAgentId: infer U }
                ? U
                : never
              : never,
            childConfig: {
              stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
              initialMessage: liveMessage,
            },
          },
        };
      }

      return {
        turnId: "turn-worker",
        blocks: [],
        updatedStateRefs: {
          lastTurnId: "turn-worker",
          turnsProcessed: input.stateRefs.turnsProcessed + 1,
        },
        spawnChild: undefined,
      };
    });

    mock.module("@temporalio/workflow", () => ({
      defineSignal: (name: string) => {
        defineSignalCalls.push(name);
        return name;
      },
      defineQuery: (name: string) => {
        defineQueryCalls.push(name);
        return name;
      },
      proxyActivities: (options: unknown) => {
        proxyActivitiesCalls.push(options);
        return { runAgentTurn };
      },
      setHandler: (definition: string, handler: (...args: any[]) => any) => {
        handlers.set(definition, handler);
      },
      condition: async (predicate: () => boolean) => {
        if (!predicate()) {
          throw new Error("condition waited without a queued message or shutdown");
        }
      },
      startChild: async (workflowType: string, options: Record<string, unknown>) => {
        startChildCalls.push({ workflowType, options });
      },
    }));

    const originalNow = Date.now;
    Date.now = () => 12345;

    try {
      const { agentWorkflow, workerWorkflow } = await import(`${WORKFLOW_MODULE_PATH}?runtime`);

      expect(typeof agentWorkflow).toBe("function");
      expect(typeof workerWorkflow).toBe("function");
      const agentConfig: AgentWorkflowConfig = {
        agentId: "agent-1" as AgentWorkflowConfig["agentId"],
        sessionId: "session-1" as AgentWorkflowConfig["sessionId"],
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
        initialMessages: [initialMessage],
        gatewayUrl: "ws://gateway",
      };

      await agentWorkflow(agentConfig);

      expect(defineSignalCalls).toEqual([MESSAGE_SIGNAL_NAME, SHUTDOWN_SIGNAL_NAME]);
      expect(defineQueryCalls).toEqual([
        STATE_QUERY_NAME,
        STATUS_QUERY_NAME,
        PENDING_COUNT_QUERY_NAME,
      ]);
      expect(proxyActivitiesCalls).toHaveLength(1);
      expect(runAgentTurn).toHaveBeenCalledTimes(1);
      expect(runAgentTurn.mock.calls[0]?.[0]?.message).toEqual(initialMessage);
      expect(runAgentTurn.mock.calls[0]?.[0]?.gatewayUrl).toBe("ws://gateway");
      expect(stateSnapshots).toEqual([{ lastTurnId: undefined, turnsProcessed: 0 }]);
      expect(currentStatus).toBe("working");
      expect(pendingDuringTurn).toBe(1);
      expect(handlers.get(STATUS_QUERY_NAME)?.()).toBe("shutting_down");
      expect(handlers.get(STATE_QUERY_NAME)?.()).toEqual({
        lastTurnId: "turn-1",
        turnsProcessed: 1,
      });
      expect(handlers.get(PENDING_COUNT_QUERY_NAME)?.()).toBe(1);
      expect(startChildCalls).toEqual([
        {
          workflowType: "workerWorkflow",
          options: {
            args: [
              {
                agentId: "child-1",
                sessionId: "session-1",
                parentAgentId: "agent-1",
                stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
                initialMessage: liveMessage,
                gatewayUrl: "ws://gateway",
              },
            ],
            workflowId: "worker:session-1:child-1:turn-1",
          },
        },
      ]);

      const workerConfig: WorkerWorkflowConfig = {
        agentId: "child-9" as WorkerWorkflowConfig["agentId"],
        sessionId: "session-9" as WorkerWorkflowConfig["sessionId"],
        parentAgentId: "parent-9" as WorkerWorkflowConfig["parentAgentId"],
        stateRefs: { lastTurnId: "prev-turn", turnsProcessed: 4 },
        gatewayUrl: "ws://worker-gateway",
        nexusApiKey: "nexus-secret",
        delegationId: "delegation-9",
      };

      const result = await workerWorkflow(workerConfig);

      expect(result.updatedStateRefs).toEqual({
        lastTurnId: "turn-worker",
        turnsProcessed: 5,
      });
      expect(runAgentTurn).toHaveBeenCalledTimes(2);
      expect(runAgentTurn.mock.calls[1]?.[0]).toEqual({
        agentId: "child-9",
        sessionId: "session-9",
        message: {
          id: "worker-init:child-9",
          senderId: "parent-9",
          content: [],
          timestamp: 12345,
        },
        stateRefs: { lastTurnId: "prev-turn", turnsProcessed: 4 },
        gatewayUrl: "ws://worker-gateway",
        nexusApiKey: "nexus-secret",
        delegationId: "delegation-9",
      });
    } finally {
      Date.now = originalNow;
    }
  });
});
