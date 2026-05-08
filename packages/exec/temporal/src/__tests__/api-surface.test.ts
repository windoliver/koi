import { expect, test } from "bun:test";
import * as api from "../index.js";

test("public api surface includes temporal signal/query exports", () => {
  expect(Object.keys(api).sort()).toEqual([
    "DEFAULT_SPAWN_LEDGER_CONFIG",
    "DEFAULT_TEMPORAL_CONFIG",
    "DEFAULT_TEMPORAL_HEALTH_CONFIG",
    "MESSAGES_SIGNAL_NAME",
    "MESSAGE_SIGNAL_NAME",
    "PENDING_COUNT_QUERY_NAME",
    "SHUTDOWN_SIGNAL_NAME",
    "STATE_QUERY_NAME",
    "STATUS_QUERY_NAME",
    "createActivities",
    "createTemporalHealthMonitor",
    "createTemporalScheduler",
    "createTemporalSpawnLedger",
    "createTemporalWorker",
    "mapKoiErrorToApplicationFailure",
    "mapTemporalError",
  ]);

  const messageSignalPayload: api.MessageSignalPayload = {
    id: "msg-1",
    senderId: "user-1",
    content: [],
    timestamp: 0,
  };
  const messagesSignalPayload: api.MessagesSignalPayload = [messageSignalPayload];

  const shutdownSignalPayload: api.ShutdownSignalPayload = {
    reason: "shutdown requested",
  };

  const stateQueryResult: api.StateQueryResult = {
    lastTurnId: undefined,
    turnsProcessed: 0,
  };

  const statusQueryResult: api.StatusQueryResult = "idle";
  const pendingCountQueryResult: api.PendingCountQueryResult = 0;
  const scheduledInputPayload: api.ScheduledInputPayload = {
    kind: "text",
    text: "hello from temporal",
    maxStopRetries: 2,
  };

  const temporalConfig: api.TemporalConfig = {
    ...api.DEFAULT_TEMPORAL_CONFIG,
    taskQueue: "temporal-api-surface",
  };

  const agentWorkflowConfig: api.AgentWorkflowConfig = {
    agentId: "agent-1" as api.AgentWorkflowConfig["agentId"],
    sessionId: "session-1" as api.AgentWorkflowConfig["sessionId"],
    stateRefs: stateQueryResult,
    initialMessages: [messageSignalPayload],
    initialScheduledInput: scheduledInputPayload,
    gatewayUrl: "ws://gateway",
    maxStopRetries: scheduledInputPayload.maxStopRetries,
  };

  const workerWorkflowConfig: api.WorkerWorkflowConfig = {
    agentId: "agent-1" as api.WorkerWorkflowConfig["agentId"],
    sessionId: "session-1" as api.WorkerWorkflowConfig["sessionId"],
    parentAgentId: "parent-1" as api.WorkerWorkflowConfig["parentAgentId"],
    stateRefs: stateQueryResult,
    initialMessage: messageSignalPayload,
    nexusApiKey: "api-key",
    delegationId: "delegation-1",
  };

  const spawnChildRequest: api.SpawnChildRequest = {
    childAgentId: "child-1" as api.SpawnChildRequest["childAgentId"],
    childConfig: {
      stateRefs: stateQueryResult,
      initialMessage: messageSignalPayload,
      nexusApiKey: "child-api-key",
      delegationId: "child-delegation-1",
    },
  };

  const scheduledSpawnArgs: api.ScheduledSpawnArgs = {
    agentId: "agent-2" as api.ScheduledSpawnArgs["agentId"],
    stateRefs: stateQueryResult,
    input: scheduledInputPayload,
  };

  const agentTurnInput: api.AgentTurnInput = {
    agentId: "agent-1" as api.AgentTurnInput["agentId"],
    sessionId: "session-1" as api.AgentTurnInput["sessionId"],
    message: messageSignalPayload,
    stateRefs: stateQueryResult,
    gatewayUrl: undefined,
    turnId: "session-1:0",
    maxStopRetries: 3,
    nexusApiKey: "api-key",
    delegationId: "delegation-1",
  };

  const agentTurnResult: api.AgentTurnResult = {
    turnId: "turn-1",
    blocks: [],
    updatedStateRefs: stateQueryResult,
    spawnChild: spawnChildRequest,
  };

  void [
    agentWorkflowConfig,
    agentTurnInput,
    agentTurnResult,
    messageSignalPayload,
    messagesSignalPayload,
    pendingCountQueryResult,
    scheduledInputPayload,
    scheduledSpawnArgs,
    shutdownSignalPayload,
    spawnChildRequest,
    stateQueryResult,
    statusQueryResult,
    temporalConfig,
    workerWorkflowConfig,
  ];
});
