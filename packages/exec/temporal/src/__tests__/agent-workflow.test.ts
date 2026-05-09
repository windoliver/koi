import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentStateRefs,
  AgentTurnInput,
  AgentTurnResult,
  AgentWorkflowConfig,
  IncomingMessage,
  ScheduledInputPayload,
  WorkerWorkflowConfig,
} from "../types.js";
import { scheduledInputToMessages } from "../workflows/scheduled-input.js";
import {
  MESSAGE_SIGNAL_NAME,
  MESSAGES_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
} from "../workflows/signals.js";

const WORKFLOW_MODULE_PATH = new URL("../workflows/agent-workflow.ts", import.meta.url).href;

type WorkflowHandler = (...args: readonly unknown[]) => unknown;

afterEach(() => {
  mock.restore();
});

describe("agent workflow module", () => {
  test("shared signal/query constants stay stable", () => {
    expect(MESSAGE_SIGNAL_NAME).toBe("message");
    expect(MESSAGES_SIGNAL_NAME).toBe("messages");
    expect(SHUTDOWN_SIGNAL_NAME).toBe("shutdown");
    expect(STATE_QUERY_NAME).toBe("getState");
    expect(STATUS_QUERY_NAME).toBe("getStatus");
    expect(PENDING_COUNT_QUERY_NAME).toBe("getPendingCount");
  });

  test("executes agent and worker workflows with gateway forwarding and scoped child ids", async () => {
    const defineSignalCalls: string[] = [];
    const defineQueryCalls: string[] = [];
    const proxyActivitiesCalls: unknown[] = [];
    const handlers = new Map<string, WorkflowHandler>();
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
    const batchMessages: IncomingMessage[] = [
      {
        id: "msg-batch-1",
        senderId: "user-3",
        content: [{ kind: "text", text: "batched-1" }],
        timestamp: 3,
      },
      {
        id: "msg-batch-2",
        senderId: "user-4",
        content: [{ kind: "text", text: "batched-2" }],
        timestamp: 4,
      },
    ];
    let agentTurnCount = 0;
    const runAgentTurn = mock(async (input: AgentTurnInput): Promise<AgentTurnResult> => {
      if (input.agentId === ("agent-1" as AgentTurnInput["agentId"])) {
        agentTurnCount++;
        if (agentTurnCount === 1) {
          stateSnapshots.push(input.stateRefs);
          currentStatus =
            (handlers.get(STATUS_QUERY_NAME)?.() as string | undefined) ?? currentStatus;
          handlers.get(MESSAGE_SIGNAL_NAME)?.(liveMessage);
          handlers.get(MESSAGES_SIGNAL_NAME)?.(batchMessages);
          pendingDuringTurn =
            (handlers.get(PENDING_COUNT_QUERY_NAME)?.() as number | undefined) ?? pendingDuringTurn;
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
                maxStopRetries: 2,
              },
            },
          };
        }
        // Drain turns: after shutdown, the workflow drains queued messages
        // before exiting. These turns return simple no-op results.
        return {
          turnId: `drain-${agentTurnCount}`,
          blocks: [],
          updatedStateRefs: {
            lastTurnId: `drain-${agentTurnCount}`,
            turnsProcessed: input.stateRefs.turnsProcessed + 1,
          },
          spawnChild: undefined,
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
      continueAsNew: async () => {},
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
      setHandler: (definition: string, handler: WorkflowHandler) => {
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
      workflowInfo: () => ({
        workflowId: "wf-test",
        runId: "run-test",
      }),
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
        maxStopRetries: 7,
      };

      await agentWorkflow(agentConfig);

      expect(defineSignalCalls).toEqual([
        MESSAGE_SIGNAL_NAME,
        MESSAGES_SIGNAL_NAME,
        "scheduled-input",
        SHUTDOWN_SIGNAL_NAME,
      ]);
      expect(defineQueryCalls).toEqual([
        STATE_QUERY_NAME,
        STATUS_QUERY_NAME,
        PENDING_COUNT_QUERY_NAME,
      ]);
      expect(proxyActivitiesCalls).toHaveLength(1);
      // Drain semantics: initial turn + 3 batched messages queued during it.
      // Shutdown only breaks the loop after the queue drains, so accepted
      // messages are not silently lost.
      expect(runAgentTurn).toHaveBeenCalledTimes(4);
      expect(runAgentTurn.mock.calls[0]?.[0]?.message).toEqual(initialMessage);
      expect(runAgentTurn.mock.calls[0]?.[0]?.gatewayUrl).toBe("ws://gateway");
      expect(runAgentTurn.mock.calls[0]?.[0]?.maxStopRetries).toBe(7);
      expect(runAgentTurn.mock.calls[1]?.[0]?.message).toEqual(liveMessage);
      expect(runAgentTurn.mock.calls[2]?.[0]?.message).toEqual(batchMessages[0]);
      expect(runAgentTurn.mock.calls[3]?.[0]?.message).toEqual(batchMessages[1]);
      expect(stateSnapshots).toEqual([{ lastTurnId: undefined, turnsProcessed: 0 }]);
      expect(currentStatus).toBe("working");
      expect(pendingDuringTurn).toBe(3);
      expect(handlers.get(STATUS_QUERY_NAME)?.()).toBe("shutting_down");
      expect(handlers.get(STATE_QUERY_NAME)?.()).toEqual({
        lastTurnId: "drain-4",
        turnsProcessed: 4,
      });
      expect(handlers.get(PENDING_COUNT_QUERY_NAME)?.()).toBe(0);
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
                maxStopRetries: 2,
              },
            ],
            parentClosePolicy: "ABANDON",
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
        maxStopRetries: 9,
      };

      const result = await workerWorkflow(workerConfig);

      expect(result.updatedStateRefs).toEqual({
        lastTurnId: "turn-worker",
        turnsProcessed: 5,
      });
      expect(runAgentTurn).toHaveBeenCalledTimes(5);
      expect(runAgentTurn.mock.calls[4]?.[0]).toEqual({
        agentId: "child-9" as AgentTurnInput["agentId"],
        sessionId: "session-9" as AgentTurnInput["sessionId"],
        message: {
          id: "worker-init:child-9",
          senderId: "parent-9",
          content: [],
          timestamp: 12345,
        },
        stateRefs: { lastTurnId: "prev-turn", turnsProcessed: 4 },
        gatewayUrl: "ws://worker-gateway",
        turnId: "worker:session-9:child-9:4",
        nexusApiKey: "nexus-secret",
        delegationId: "delegation-9",
        maxStopRetries: 9,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("maps scheduled spawn input to queued messages", () => {
    const scheduledPayload: ScheduledInputPayload = {
      kind: "resume",
      state: { engineId: "engine-1", data: { checkpoint: "abc" } },
      maxStopRetries: 4,
    };
    expect(scheduledInputToMessages(scheduledPayload, "seed-1", 1234)).toEqual([
      {
        id: "seed-1:resume",
        senderId: "scheduler",
        content: [],
        timestamp: 1234,
        resumeState: scheduledPayload.state,
      },
    ]);
  });
});
