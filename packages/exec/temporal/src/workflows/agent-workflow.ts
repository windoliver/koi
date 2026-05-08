import {
  type AgentTurnResult,
  createDefaultAgentActivities,
  getAgentWorkflowMessages,
} from "../activities/agent-activity.js";
import type { AgentWorkflowConfig } from "../types.js";

interface AgentWorkflowDeps {
  readonly runAgentTurn: (input: AgentWorkflowConfig) => Promise<AgentTurnResult>;
}

const defaultAgentActivities = createDefaultAgentActivities();

const defaultAgentWorkflowDeps: AgentWorkflowDeps = {
  runAgentTurn: defaultAgentActivities.runAgentTurn,
};

let agentWorkflowDeps: AgentWorkflowDeps = defaultAgentWorkflowDeps;

export function setAgentWorkflowDepsForTest(overrides: Partial<AgentWorkflowDeps>): void {
  agentWorkflowDeps = { ...defaultAgentWorkflowDeps, ...overrides };
}

export function resetAgentWorkflowDepsForTest(): void {
  agentWorkflowDeps = defaultAgentWorkflowDeps;
}

export async function agentWorkflow(config: AgentWorkflowConfig): Promise<void> {
  const messages = getAgentWorkflowMessages(config);
  if (messages.length === 0) {
    return;
  }

  let stateRefs = config.stateRefs;
  let remainingStopRetries = Math.max(config.maxStopRetries ?? 0, 0);
  const maxTurns = messages.length + Math.max(config.maxStopRetries ?? 0, 0);

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const previousStateRefs = stateRefs;
    const result = await agentWorkflowDeps.runAgentTurn({
      ...config,
      stateRefs,
      initialMessage: undefined,
      initialMessages: messages,
    });

    stateRefs = result.updatedStateRefs;
    if (result.next.kind === "complete") {
      return;
    }

    const progressed =
      stateRefs.turnsProcessed > previousStateRefs.turnsProcessed ||
      stateRefs.lastTurnId !== previousStateRefs.lastTurnId;
    if (!progressed) {
      if (remainingStopRetries <= 0) {
        throw new Error("agent workflow requested retry without advancing state");
      }
      remainingStopRetries -= 1;
    }
  }

  throw new Error("agent workflow exhausted turn budget before completion");
}
