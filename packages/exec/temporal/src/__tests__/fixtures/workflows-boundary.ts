import type {
  AgentWorkflowConfig,
  RetryWorkflowArgs,
  RetryWorkflowResult,
  ScheduledInputPayload,
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
const spawnedResult: ScheduledTaskWorkflowResult = {
  kind: "spawned",
  workflowId: "wf-1",
};
const retryResult: RetryWorkflowResult = { kind: "succeeded", attempts: 1, value: {} };
const failedRetryResult: RetryWorkflowResult = {
  kind: "failed",
  attempts: 2,
  error: "boom",
};

function inspectScheduledArgs(args: ScheduledTaskWorkflowArgs): string {
  const mode: "spawn" | "dispatch" = args.mode;
  const agentId: AgentWorkflowConfig["agentId"] = args.agentId;
  const turnCount: number = args.stateRefs.turnsProcessed;
  switch (args.input.kind) {
    case "text": {
      const text: string = args.input.text;
      return `${mode}:${String(agentId)}:${turnCount}:${text}`;
    }
    case "messages": {
      const messageCount: number = args.input.messages.length;
      return `${mode}:${String(agentId)}:${turnCount}:${messageCount}`;
    }
    case "resume": {
      const engineId: string = args.input.state.engineId;
      const data: unknown = args.input.state.data;
      return `${mode}:${String(agentId)}:${turnCount}:${engineId}:${String(data)}`;
    }
  }
}

function inspectScheduledResult(result: ScheduledTaskWorkflowResult): string {
  switch (result.kind) {
    case "spawned": {
      const workflowId: string = result.workflowId;
      return workflowId;
    }
    case "dispatched":
      return "dispatched";
  }
}

function inspectRetryResult(result: RetryWorkflowResult): string {
  switch (result.kind) {
    case "succeeded": {
      const attempts: number = result.attempts;
      const value: unknown = result.value;
      return `${attempts}:${String(value)}`;
    }
    case "failed": {
      const attempts: number = result.attempts;
      const error: string = result.error;
      return `${attempts}:${error}`;
    }
  }
}

void inspectScheduledArgs(scheduled);
void inspectScheduledResult(scheduledResult);
void inspectScheduledResult(spawnedResult);
void inspectRetryResult(retryResult);
void inspectRetryResult(failedRetryResult);
