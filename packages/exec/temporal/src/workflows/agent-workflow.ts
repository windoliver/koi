/**
 * Entity Workflow — long-running copilot agent.
 *
 * This file runs inside Temporal's deterministic V8 sandbox.
 * It MUST NOT import Node.js/Bun modules or perform I/O directly.
 * All non-deterministic operations go through Activities.
 *
 * Pattern: Entity Workflow (always-on, signal-driven, Continue-As-New).
 * Decisions: 7B (CAN drain), 16A (lightweight state refs).
 */

import {
  allHandlersFinished,
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
  WorkerWorkflowConfig,
} from "../types.js";

import {
  type AgentActivityStatus,
  MESSAGE_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  type ShutdownSignalPayload,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
} from "./signals.js";

// ---------------------------------------------------------------------------
// Signal/query definitions (must be at module scope for Temporal registration)
// ---------------------------------------------------------------------------

const messageSignal = defineSignal<[IncomingMessage]>(MESSAGE_SIGNAL_NAME);
const shutdownSignal = defineSignal<[ShutdownSignalPayload]>(SHUTDOWN_SIGNAL_NAME);
const stateQuery = defineQuery<AgentStateRefs>(STATE_QUERY_NAME);
const statusQuery = defineQuery<AgentActivityStatus>(STATUS_QUERY_NAME);
const pendingCountQuery = defineQuery<number>(PENDING_COUNT_QUERY_NAME);

// ---------------------------------------------------------------------------
// Activity stubs (proxyActivities creates typed proxies)
// ---------------------------------------------------------------------------

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

const { runAgentTurn: runAgentTurnLong } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    backoffCoefficient: 2,
  },
});

// ---------------------------------------------------------------------------
// Entity Workflow
// ---------------------------------------------------------------------------

/**
 * Agent Entity Workflow — represents a single copilot agent.
 *
 * Lifecycle:
 * 1. Register signal/query handlers
 * 2. Wait for messages via `condition()` (suspends to disk, zero memory)
 * 3. Execute agent turn via Activity (LLM call + tool execution)
 * 4. Update state refs (lightweight, <1KB)
 * 5. Spawn child workflows if requested (worker agents)
 * 6. Continue-As-New when history grows (Decision 7B)
 */
export async function agentWorkflow(config: AgentWorkflowConfig): Promise<void> {
  let stateRefs: AgentStateRefs = config.stateRefs;
  const pendingMessages: IncomingMessage[] = [];
  let shutdownRequested = false;
  let processingTurn = false;

  // Seed with initial message(s) if provided (cron schedules, Continue-As-New).
  // `initialMessages` (plural) takes precedence — used by cron schedules with
  // multi-message EngineInput. `initialMessage` (singular) is the legacy path.
  if (config.initialMessages !== undefined && config.initialMessages.length > 0) {
    for (const msg of config.initialMessages) {
      pendingMessages.push(msg);
    }
  } else if (config.initialMessage !== undefined) {
    pendingMessages.push(config.initialMessage);
  }

  // -- Signal handlers -------------------------------------------------------

  // Mutable array is required here — Temporal signal handlers must push
  // into a shared queue that the main loop drains. This is the canonical
  // Entity Workflow pattern from Temporal's own documentation.
  setHandler(messageSignal, (msg: IncomingMessage) => {
    pendingMessages.push(msg);
  });

  setHandler(shutdownSignal, (_payload: ShutdownSignalPayload) => {
    shutdownRequested = true;
  });

  // -- Query handlers --------------------------------------------------------

  setHandler(stateQuery, (): AgentStateRefs => stateRefs);

  setHandler(statusQuery, (): AgentActivityStatus => {
    if (shutdownRequested) return "shutting_down";
    if (processingTurn) return "working";
    return pendingMessages.length > 0 ? "working" : "idle";
  });

  setHandler(pendingCountQuery, (): number => pendingMessages.length);

  // -- Main loop -------------------------------------------------------------

  while (!shutdownRequested) {
    // Suspend to disk — zero memory cost while idle.
    // Wakes instantly on signal (not polling).
    await condition(() => pendingMessages.length > 0 || shutdownRequested);

    if (shutdownRequested) break;

    // Process the next pending message
    const msg = pendingMessages.shift();
    if (msg === undefined) continue;

    // Execute agent turn via Activity (non-deterministic → Activity)
    const turnInput: AgentTurnInput = {
      agentId: config.agentId,
      sessionId: config.sessionId,
      message: msg,
      stateRefs,
      gatewayUrl: undefined, // Injected by Activity context at runtime
    };

    processingTurn = true;
    const result: AgentTurnResult = await runAgentTurn(turnInput);
    processingTurn = false;

    // Update lightweight state refs (Decision 16A)
    stateRefs = result.updatedStateRefs;

    // Spawn child workflow if requested (worker agent)
    if (result.spawnChild !== undefined) {
      const childConfig: WorkerWorkflowConfig = {
        agentId: result.spawnChild.childAgentId,
        sessionId: config.sessionId,
        parentAgentId: config.agentId,
        stateRefs: result.spawnChild.childConfig.stateRefs,
        initialMessage: result.spawnChild.childConfig.initialMessage,
      };

      await startChild("workerWorkflow", {
        args: [childConfig],
        workflowId: `worker:${result.spawnChild.childAgentId}`,
        parentClosePolicy: "TERMINATE",
      });
    }

    // -- Continue-As-New check (Decision 7B) ---------------------------------
    // Use server-recommended threshold, not hardcoded event count.
    if (workflowInfo().continueAsNewSuggested) {
      // Drain all pending messages before CAN
      while (pendingMessages.length > 0) {
        const remaining = pendingMessages.shift();
        if (remaining === undefined) break;

        const drainInput: AgentTurnInput = {
          agentId: config.agentId,
          sessionId: config.sessionId,
          message: remaining,
          stateRefs,
          gatewayUrl: undefined,
        };

        const drainResult: AgentTurnResult = await runAgentTurn(drainInput);

        stateRefs = drainResult.updatedStateRefs;
      }

      // Wait for all in-flight signal/update handlers to complete
      await condition(allHandlersFinished);

      // Continue-As-New with updated state refs (<1KB payload).
      // Clear initialMessage/initialMessages to prevent replay —
      // those were already processed in the current execution.
      await continueAsNew<typeof agentWorkflow>({
        ...config,
        stateRefs,
        initialMessage: undefined,
        initialMessages: undefined,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Worker Workflow (child)
// ---------------------------------------------------------------------------

/**
 * Worker Workflow — task-scoped child of a copilot agent.
 *
 * Executes a single task and returns the result to the parent.
 * Does NOT connect to Nexus independently (same as today's worker semantics).
 */
export async function workerWorkflow(config: WorkerWorkflowConfig): Promise<AgentTurnResult> {
  // Worker processes a single "turn" — the task assigned by the parent.
  // Uses initialMessage from parent if provided; otherwise synthesizes an init message.
  const message = config.initialMessage ?? {
    id: `worker-init:${config.agentId}`,
    senderId: config.parentAgentId,
    content: [],
    // Date.now() is safe in Temporal's sandbox — it's part of the
    // deterministic API that Temporal patches to replay correctly.
    timestamp: Date.now(),
  };

  const input: AgentTurnInput = {
    agentId: config.agentId,
    sessionId: config.sessionId,
    message,
    stateRefs: config.stateRefs,
    gatewayUrl: undefined,
  };

  return runAgentTurnLong(input);
}
