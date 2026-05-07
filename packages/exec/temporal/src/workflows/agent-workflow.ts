import {
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  condition,
  startChild,
} from "@temporalio/workflow";

import type {
  AgentStateRefs,
  AgentTurnInput,
  AgentTurnResult,
  AgentWorkflowConfig,
  IncomingMessage,
  WorkerWorkflowConfig,
} from "../types.js";
import {
  MESSAGE_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
  type AgentActivityStatus,
  type ShutdownSignalPayload,
} from "./signals.js";

const messageSignal = defineSignal<[IncomingMessage]>(MESSAGE_SIGNAL_NAME);
const shutdownSignal = defineSignal<[ShutdownSignalPayload]>(SHUTDOWN_SIGNAL_NAME);
const stateQuery = defineQuery<AgentStateRefs>(STATE_QUERY_NAME);
const statusQuery = defineQuery<AgentActivityStatus>(STATUS_QUERY_NAME);
const pendingCountQuery = defineQuery<number>(PENDING_COUNT_QUERY_NAME);

interface AgentActivities {
  readonly runAgentTurn: (input: AgentTurnInput) => Promise<AgentTurnResult>;
}

const { runAgentTurn } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    backoffCoefficient: 2,
  },
});

export async function agentWorkflow(config: AgentWorkflowConfig): Promise<void> {
  let stateRefs = config.stateRefs;
  const pendingMessages: IncomingMessage[] = [];
  let processingTurn = false;
  let shutdownRequested = false;

  if (config.initialMessages !== undefined && config.initialMessages.length > 0) {
    pendingMessages.push(...config.initialMessages);
  } else if (config.initialMessage !== undefined) {
    pendingMessages.push(config.initialMessage);
  }

  setHandler(messageSignal, (message: IncomingMessage) => {
    pendingMessages.push(message);
  });

  setHandler(shutdownSignal, (_payload: ShutdownSignalPayload) => {
    shutdownRequested = true;
  });

  setHandler(stateQuery, () => stateRefs);
  setHandler(statusQuery, (): AgentActivityStatus => {
    if (shutdownRequested) return "shutting_down";
    if (processingTurn || pendingMessages.length > 0) return "working";
    return "idle";
  });
  setHandler(pendingCountQuery, () => pendingMessages.length);

  while (true) {
    await condition(() => pendingMessages.length > 0 || shutdownRequested);

    if (shutdownRequested) {
      break;
    }

    const message = pendingMessages.shift();
    if (message === undefined) {
      continue;
    }

    processingTurn = true;
    let result: AgentTurnResult;
    try {
      result = await runAgentTurn({
        agentId: config.agentId,
        sessionId: config.sessionId,
        message,
        stateRefs,
        gatewayUrl: config.gatewayUrl,
      });
    } finally {
      processingTurn = false;
    }

    stateRefs = result.updatedStateRefs;

    if (result.spawnChild !== undefined) {
      const childConfig: WorkerWorkflowConfig = {
        ...result.spawnChild.childConfig,
        agentId: result.spawnChild.childAgentId,
        sessionId: config.sessionId,
        parentAgentId: config.agentId,
        gatewayUrl: result.spawnChild.childConfig.gatewayUrl ?? config.gatewayUrl,
      };

      await startChild("workerWorkflow", {
        args: [childConfig],
        workflowId: buildChildWorkflowId(
          config.sessionId,
          result.spawnChild.childAgentId,
          result.turnId,
        ),
      });
    }

    if (shutdownRequested) {
      break;
    }
  }
}

export async function workerWorkflow(config: WorkerWorkflowConfig): Promise<AgentTurnResult> {
  const message =
    config.initialMessage ??
    ({
      id: `worker-init:${config.agentId}`,
      senderId: config.parentAgentId,
      content: [],
      timestamp: Date.now(),
    } satisfies IncomingMessage);

  return runAgentTurn({
    agentId: config.agentId,
    sessionId: config.sessionId,
    message,
    stateRefs: config.stateRefs,
    gatewayUrl: config.gatewayUrl,
    nexusApiKey: config.nexusApiKey,
    delegationId: config.delegationId,
  });
}

function buildChildWorkflowId(
  sessionId: AgentWorkflowConfig["sessionId"],
  childAgentId: WorkerWorkflowConfig["agentId"],
  turnId: AgentTurnResult["turnId"],
): string {
  return `worker:${sessionId}:${childAgentId}:${turnId}`;
}
