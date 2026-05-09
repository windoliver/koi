import { sessionId as makeSessionId } from "@koi/core";
import {
  condition,
  continueAsNew,
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
  // Scheduled spawns (cron firings via Temporal Schedules) must terminate so
  // that the schedule's overlap policy (e.g. SKIP) sees the run as completed
  // and the next firing can start. Long-lived dispatch workflows keep
  // listening for signals; scheduled firings exit after draining their
  // initial input + any signals that arrived during the turn.
  const isScheduledFiring =
    config.initialScheduledInput !== undefined || config.terminateWhenIdle === true;
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
    // Scheduled firings ignore live signals: their work is fully described
    // by initialScheduledInput. Without this, external senders targeting
    // the stable schedule workflowId could keep the queue non-empty
    // indefinitely and block subsequent cron ticks under SKIP overlap.
    // Once shutdown is requested, stop accepting new work so the drain loop
    // can terminate (otherwise a steady signal stream would extend the run
    // past shutdown indefinitely).
    if (isScheduledFiring || shutdownRequested) return;
    pendingMessages.push(message);
  });
  setHandler(messagesSignal, (messages: readonly IncomingMessage[]) => {
    if (isScheduledFiring || shutdownRequested) return;
    pendingMessages.push(...messages);
  });
  setHandler(scheduledInputSignal, (input: ScheduledInputPayload) => {
    if (isScheduledFiring || shutdownRequested) return;
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

    // Drain on shutdown: process already-queued messages before exiting so
    // that signals accepted at the transport layer are not silently lost.
    // The signal handlers above stop accepting NEW work for scheduled
    // firings, so this loop terminates cleanly: queue can only shrink once
    // shutdown is set on a long-lived workflow (live senders are expected
    // to stop targeting it), and is bounded by initialScheduledInput +
    // initialMessages on a scheduled firing.
    if (shutdownRequested && pendingMessages.length === 0) {
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
        // Scheduled firings auto-terminate when drained. A spawned child
        // (launched with ABANDON parent close policy) could outlive the
        // parent and overlap with the next cron tick, breaking SKIP/BUFFER
        // serialization. Forbid spawn at activity layer: any spawn_requested
        // becomes a non-retryable ApplicationFailure rather than starting a
        // child the parent cannot wait on.
        ...(isScheduledFiring ? { allowSpawn: false } : {}),
      });
    } finally {
      processingTurn = false;
    }

    stateRefs = result.updatedStateRefs;

    if (result.spawnChild !== undefined) {
      // Scheduled firings cannot spawn children: the parent auto-terminates
      // when its queue drains, but children are launched with ABANDON parent
      // close policy, so the parent run could complete while a child is
      // still active. Under SKIP/BUFFER overlap policies the next cron tick
      // would then start concurrently with leftover child work, breaking
      // schedule serialization. Reject spawn requests in this mode.
      if (isScheduledFiring) {
        throw new Error(
          "Scheduled firings cannot spawn child workflows: the parent would " +
            "auto-terminate before the child completes and break schedule overlap policy",
        );
      }
      const childConfig: WorkerWorkflowConfig = {
        ...result.spawnChild.childConfig,
        agentId: result.spawnChild.childAgentId,
        sessionId: effectiveSessionId,
        parentAgentId: config.agentId,
        gatewayUrl: result.spawnChild.childConfig.gatewayUrl ?? config.gatewayUrl,
      };

      // Skip spawning if the parent's deadline has already elapsed by the
      // time we get here (queue, retry, or worker delay between spawn
      // capture and child start). Mirrors the in-process spawn fast-path
      // rejection so expired children never consume worker capacity.
      const deadlineExpired =
        childConfig.absoluteDeadlineMs !== undefined &&
        childConfig.absoluteDeadlineMs <= Date.now();
      if (!deadlineExpired) {
        await startChild("workerWorkflow", {
          args: [childConfig],
          workflowId: buildChildWorkflowId(
            effectiveSessionId,
            result.spawnChild.childAgentId,
            result.turnId,
          ),
          // ABANDON: parent may continueAsNew immediately after spawning;
          // default TERMINATE would kill an in-flight child mid-turn.
          parentClosePolicy: "ABANDON",
        });
      }
    }

    // Cap workflow history before Temporal forces a hard failure. Roll over
    // after every completed turn once the server suggests it; carry pending
    // backlog into the new run so high-traffic workflows still rotate.
    // Temporal buffers in-flight signals during the continueAsNew handoff,
    // so this does not race with concurrent senders. Carried payload is
    // typically small (per-turn drain), bounded in practice by signal rate
    // and Temporal's per-arg size limit.
    if (isScheduledFiring && pendingMessages.length === 0) {
      break;
    }

    if (workflowInfo().continueAsNewSuggested && !shutdownRequested) {
      const carryConfig: AgentWorkflowConfig = {
        ...config,
        sessionId: effectiveSessionId,
        stateRefs,
        initialMessage: undefined,
        initialMessages: [...pendingMessages],
        initialScheduledInput: undefined,
        // Preserve auto-terminate behavior: scheduled firings rotated via
        // continueAsNew must still exit when drained, otherwise the next
        // cron tick is blocked under SKIP overlap policy.
        terminateWhenIdle: isScheduledFiring,
      };
      await continueAsNew<typeof agentWorkflow>(carryConfig);
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
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.absoluteDeadlineMs !== undefined
      ? { absoluteDeadlineMs: config.absoluteDeadlineMs }
      : {}),
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
  // Include workflowInfo().runId so message IDs cannot collide across
  // continueAsNew rollovers — each Temporal run has a unique runId, so
  // scheduledBatchCount restarting at 0 in the new run cannot mint the
  // same IncomingMessage.id as the previous run.
  return `scheduled:${sessionId}:${workflowInfo().runId}:${Date.now()}:${batch}`;
}
