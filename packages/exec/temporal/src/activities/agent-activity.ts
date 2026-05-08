import type { AgentStateRefs, AgentWorkflowConfig, IncomingMessage } from "../types.js";

export interface AgentTurnResult {
  readonly turnId: string;
  readonly updatedStateRefs: AgentStateRefs;
  readonly next: { readonly kind: "complete" | "retry" };
}

export interface AgentActivityDeps {
  readonly runTurn: (input: AgentWorkflowConfig) => Promise<AgentTurnResult>;
}

export function createAgentActivities(deps: AgentActivityDeps) {
  return {
    async runAgentTurn(input: AgentWorkflowConfig): Promise<AgentTurnResult> {
      return deps.runTurn(input);
    },
  };
}

export function getAgentWorkflowMessages(config: AgentWorkflowConfig): readonly IncomingMessage[] {
  if (config.initialMessages !== undefined) {
    return config.initialMessages;
  }

  return config.initialMessage === undefined ? [] : [config.initialMessage];
}

export function createDefaultAgentActivities() {
  return createAgentActivities({
    async runTurn(input: AgentWorkflowConfig): Promise<AgentTurnResult> {
      const messages = getAgentWorkflowMessages(input);
      if (messages.length === 0) {
        return {
          turnId: input.stateRefs.lastTurnId ?? `${String(input.sessionId)}:idle`,
          updatedStateRefs: input.stateRefs,
          next: { kind: "complete" },
        };
      }

      const lastProcessedIndex =
        input.stateRefs.lastTurnId === undefined
          ? -1
          : messages.findIndex((message) => message.id === input.stateRefs.lastTurnId);
      const nextMessageIndex = lastProcessedIndex + 1;

      if (nextMessageIndex >= messages.length) {
        const lastMessageId =
          messages[messages.length - 1]?.id ?? `${String(input.sessionId)}:idle`;
        return {
          turnId: input.stateRefs.lastTurnId ?? lastMessageId,
          updatedStateRefs: input.stateRefs,
          next: { kind: "complete" },
        };
      }

      const currentMessage = messages[nextMessageIndex];
      if (currentMessage === undefined) {
        throw new Error("agent activity could not resolve the next message to process");
      }
      const turnsProcessed = input.stateRefs.turnsProcessed + 1;

      return {
        turnId: currentMessage.id,
        updatedStateRefs: {
          lastTurnId: currentMessage.id,
          turnsProcessed,
        },
        next: { kind: nextMessageIndex < messages.length - 1 ? "retry" : "complete" },
      };
    },
  });
}
