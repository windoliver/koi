import type { AgentWorkflowConfig, IncomingMessage, ScheduledTaskWorkflowArgs } from "../types.js";

export interface ScheduledTaskActivityDeps {
  readonly spawn: (input: ScheduledTaskWorkflowArgs) => Promise<string>;
  readonly dispatch: (input: ScheduledTaskWorkflowArgs) => Promise<void>;
}

export function createScheduledTaskActivities(deps: ScheduledTaskActivityDeps) {
  return {
    async startAgentExecution(input: ScheduledTaskWorkflowArgs) {
      return deps.spawn(input);
    },
    async dispatchToAgent(input: ScheduledTaskWorkflowArgs) {
      await deps.dispatch(input);
    },
  };
}

export interface DefaultScheduledTaskActivityDeps {
  readonly runAgentWorkflow: (input: AgentWorkflowConfig) => Promise<void>;
  readonly spawnAgentWorkflow?:
    | ((workflowId: string, input: AgentWorkflowConfig) => Promise<void>)
    | undefined;
  readonly createWorkflowId?: (() => string) | undefined;
}

function materializeScheduledMessages(
  input: ScheduledTaskWorkflowArgs["input"],
  workflowId: string,
): readonly IncomingMessage[] {
  const now = Date.now();

  switch (input.kind) {
    case "text":
      return [
        {
          id: `${workflowId}:0`,
          senderId: "scheduler",
          content: [{ kind: "text", text: input.text }],
          timestamp: now,
        },
      ];
    case "messages":
      return input.messages.map(
        (message, index): IncomingMessage => ({
          id: `${workflowId}:${index}`,
          senderId: message.senderId,
          content: [...message.content],
          timestamp: message.timestamp,
          threadId: message.threadId,
          metadata: message.metadata as Record<string, unknown> | undefined,
          pinned: message.pinned,
        }),
      );
    case "resume":
      return [
        {
          id: `${workflowId}:resume`,
          senderId: "scheduler",
          content: [],
          timestamp: now,
          resumeState: input.state,
        },
      ];
  }
}

export function materializeScheduledAgentWorkflowConfig(
  args: ScheduledTaskWorkflowArgs,
  sessionId: string,
): AgentWorkflowConfig {
  return {
    agentId: args.agentId,
    sessionId: sessionId as never,
    stateRefs: args.stateRefs,
    initialMessages: materializeScheduledMessages(args.input, sessionId),
    ...(args.input.maxStopRetries !== undefined
      ? { maxStopRetries: args.input.maxStopRetries }
      : {}),
  };
}

export function createDefaultScheduledTaskActivities(deps: DefaultScheduledTaskActivityDeps) {
  return createScheduledTaskActivities({
    async spawn(input: ScheduledTaskWorkflowArgs): Promise<string> {
      const workflowId =
        deps.createWorkflowId?.() ?? `scheduled:${String(input.agentId)}:${crypto.randomUUID()}`;
      const config = materializeScheduledAgentWorkflowConfig(input, workflowId);
      if (deps.spawnAgentWorkflow !== undefined) {
        await deps.spawnAgentWorkflow(workflowId, config);
      } else {
        await deps.runAgentWorkflow(config);
      }
      return workflowId;
    },
    async dispatch(input: ScheduledTaskWorkflowArgs): Promise<void> {
      await deps.runAgentWorkflow(
        materializeScheduledAgentWorkflowConfig(input, String(input.agentId)),
      );
    },
  });
}
