import type {
  AgentWorkflowConfig,
  RetryWorkflowArgs,
  RetryWorkflowResult,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
} from "../../index.js";

const agentConfig: AgentWorkflowConfig = {
  agentId: "agent-1" as AgentWorkflowConfig["agentId"],
  sessionId: "session-1" as AgentWorkflowConfig["sessionId"],
  stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
};

const scheduled: ScheduledTaskWorkflowArgs = {
  mode: "dispatch",
  agentId: agentConfig.agentId,
  stateRefs: agentConfig.stateRefs,
  input: { kind: "text", text: "hello" },
};

const retryArgs: RetryWorkflowArgs = {
  operation: "runAgentTurn",
  attempt: 0,
  maxAttempts: 3,
  backoffMs: 250,
  payload: { agentId: agentConfig.agentId },
};

const scheduledResult: ScheduledTaskWorkflowResult = { kind: "dispatched" };
const retryResult: RetryWorkflowResult = { kind: "succeeded", attempts: 1, value: {} };

void scheduled;
void retryArgs;
void scheduledResult;
void retryResult;
