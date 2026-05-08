import {
  AGENT_MESSAGE_SIGNAL,
  AGENT_STATE_QUERY,
  AGENT_WORKFLOW_NAME,
  type AgentWorkflowConfig,
  agentWorkflow,
  RETRY_WORKFLOW_NAME,
  type RetryWorkflowArgs,
  retryWorkflow,
  SCHEDULED_TASK_WORKFLOW_NAME,
  type ScheduledTaskWorkflowArgs,
  scheduledTaskWorkflow,
} from "../../index.js";

const config: AgentWorkflowConfig = {
  agentId: "agent-1" as AgentWorkflowConfig["agentId"],
  sessionId: "session-1" as AgentWorkflowConfig["sessionId"],
  stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
};

const scheduledArgs: ScheduledTaskWorkflowArgs = {
  mode: "dispatch",
  agentId: config.agentId,
  stateRefs: config.stateRefs,
  input: { kind: "text", text: "hello" },
};

const retryArgs: RetryWorkflowArgs = {
  operation: "runAgentTurn",
  attempt: 0,
  maxAttempts: 3,
  backoffMs: 250,
  payload: { agentId: config.agentId },
};

const _signal1: "agent.message" = AGENT_MESSAGE_SIGNAL;
const _signal2: "agent.state" = AGENT_STATE_QUERY;
const _workflowName1: "agentWorkflow" = AGENT_WORKFLOW_NAME;
const _workflowName2: "scheduledTaskWorkflow" = SCHEDULED_TASK_WORKFLOW_NAME;
const _workflowName3: "retryWorkflow" = RETRY_WORKFLOW_NAME;

void agentWorkflow(config);
void scheduledTaskWorkflow(scheduledArgs);
void retryWorkflow(retryArgs);
void _signal1;
void _signal2;
void _workflowName1;
void _workflowName2;
void _workflowName3;
