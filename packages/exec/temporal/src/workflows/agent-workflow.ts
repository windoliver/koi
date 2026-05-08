import { sessionId as makeSessionId } from "@koi/core";
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";

import type {
  AgentStateRefs,
  AgentTurnInput,
  AgentTurnResult,
  AgentWorkflowConfig,
  IncomingMessage,
  ScheduledInputPayload,
  WorkerWorkflowConfig,
} from "../types.js";
import { SCHEDULED_INPUT_SIGNAL_NAME, scheduledInputToMessages } from "./scheduled-input.js";
import {
  type AgentActivityStatus,
  MESSAGE_SIGNAL_NAME,
  MESSAGES_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  type ShutdownSignalPayload,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
} from "./signals.js";

const messageSignal = defineSignal<[IncomingMessage]>(MESSAGE_SIGNAL_NAME);
const messagesSignal = defineSignal<[readonly IncomingMessage[]]>(MESSAGES_SIGNAL_NAME);
const scheduledInputSignal = defineSignal<[ScheduledInputPayload]>(SCHEDULED_INPUT_SIGNAL_NAME);
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
  // For scheduled spawns (initialScheduledInput present) compose a per-firing
  // session identity from the supplied base sessionId plus workflowInfo().runId.
  // runId is guaranteed-unique per Temporal execution, so each cron firing gets
  // distinct session-scoped state. The base id remains in the prefix so callers
  // can correlate runs back to the schedule, and runId is observable via the
  // Temporal client (e.g. schedule.getHandle().describe()).
  // For one-shot/dispatch flows the caller-supplied sessionId is already
  // unique-per-execution and is used verbatim.
  const baseSessionId = config.sessionId;
  const effectiveSessionId =
    config.initialScheduledInput !== undefined
      ? makeSessionId(
          baseSessionId !== undefined
            ? `${baseSessionId}:${workflowInfo().runId}`
            : `${workflowInfo().workflowId}:${workflowInfo().runId}`,
        )
      : (baseSessionId ?? makeSessionId(workflowInfo().workflowId));
  let stateRefs = config.stateRefs;
  const pendingMessages: IncomingMessage[] = [];
  let processingTurn = false;
  let shutdownRequested = false;
  let scheduledBatchCount = 0;

  const enqueueScheduledInput = (input: ScheduledInputPayload) => {
    pendingMessages.push(
      ...scheduledInputToMessages(
        input,
        buildScheduledMessageSeed(effectiveSessionId, scheduledBatchCount),
      ),
    );
    scheduledBatchCount++;
  };

  if (config.initialMessages !== undefined && config.initialMessages.length > 0) {
    pendingMessages.push(...config.initialMessages);
  } else if (config.initialMessage !== undefined) {
    pendingMessages.push(config.initialMessage);
  }
  if (config.initialScheduledInput !== undefined) {
    enqueueScheduledInput(config.initialScheduledInput);
  }

  setHandler(messageSignal, (message: IncomingMessage) => {
    pendingMessages.push(message);
  });
  setHandler(messagesSignal, (messages: readonly IncomingMessage[]) => {
    pendingMessages.push(...messages);
  });
  setHandler(scheduledInputSignal, (input: ScheduledInputPayload) => {
    enqueueScheduledInput(input);
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
    // Stable turnId derived from workflow identity + turn counter. Survives
    // Temporal activity retries so streamed gateway frames keep a usable
    // (turnId, frameIndex) idempotency key.
    const turnId = `${effectiveSessionId}:${stateRefs.turnsProcessed}`;
    try {
      result = await runAgentTurn({
        agentId: config.agentId,
        sessionId: effectiveSessionId,
        message,
        stateRefs,
        gatewayUrl: config.gatewayUrl,
        turnId,
        maxStopRetries: config.maxStopRetries,
      });
    } finally {
      processingTurn = false;
    }

    stateRefs = result.updatedStateRefs;

    if (result.spawnChild !== undefined) {
      const childConfig: WorkerWorkflowConfig = {
        ...result.spawnChild.childConfig,
        agentId: result.spawnChild.childAgentId,
        sessionId: effectiveSessionId,
        parentAgentId: config.agentId,
        gatewayUrl: result.spawnChild.childConfig.gatewayUrl ?? config.gatewayUrl,
      };

      await startChild("workerWorkflow", {
        args: [childConfig],
        workflowId: buildChildWorkflowId(
          effectiveSessionId,
          result.spawnChild.childAgentId,
          result.turnId,
        ),
      });
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

  const turnId = `worker:${config.sessionId}:${config.agentId}:${config.stateRefs.turnsProcessed}`;
  return runAgentTurn({
    agentId: config.agentId,
    sessionId: config.sessionId,
    message,
    stateRefs: config.stateRefs,
    gatewayUrl: config.gatewayUrl,
    turnId,
    maxStopRetries: config.maxStopRetries,
    nexusApiKey: config.nexusApiKey,
    delegationId: config.delegationId,
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.nonInteractive !== undefined ? { nonInteractive: config.nonInteractive } : {}),
    ...(config.toolAllowlist !== undefined ? { toolAllowlist: config.toolAllowlist } : {}),
    ...(config.toolDenylist !== undefined ? { toolDenylist: config.toolDenylist } : {}),
    ...(config.fork !== undefined ? { fork: config.fork } : {}),
    ...(config.allowNestedSpawn !== undefined ? { allowNestedSpawn: config.allowNestedSpawn } : {}),
  });
}

function buildChildWorkflowId(
  sessionId: AgentWorkflowConfig["sessionId"],
  childAgentId: WorkerWorkflowConfig["agentId"],
  turnId: AgentTurnResult["turnId"],
): string {
  return `worker:${sessionId}:${childAgentId}:${turnId}`;
}

function buildScheduledMessageSeed(
  sessionId: AgentWorkflowConfig["sessionId"],
  batch: number,
): string {
  return `scheduled:${sessionId}:${Date.now()}:${batch}`;
}
