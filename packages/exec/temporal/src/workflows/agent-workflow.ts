import type { AgentStateRefs, AgentWorkflowConfig } from "../types.js";

interface AgentWorkflowRunResult {
  readonly turnId: string;
  readonly updatedStateRefs: AgentStateRefs;
  readonly next: { readonly kind: "complete" | "retry" };
}

interface AgentWorkflowDeps {
  readonly runAgentTurn: (input: AgentWorkflowConfig) => Promise<AgentWorkflowRunResult>;
}

const defaultAgentWorkflowDeps: AgentWorkflowDeps = {
  runAgentTurn: async (input) => {
    const turnId = input.stateRefs.lastTurnId ?? `turn-${input.stateRefs.turnsProcessed + 1}`;
    return {
      turnId,
      updatedStateRefs: {
        lastTurnId: turnId,
        turnsProcessed: input.stateRefs.turnsProcessed + 1,
      },
      next: { kind: "complete" },
    };
  },
};

let agentWorkflowDeps: AgentWorkflowDeps = defaultAgentWorkflowDeps;

export function setAgentWorkflowDepsForTest(overrides: Partial<AgentWorkflowDeps>): void {
  agentWorkflowDeps = { ...defaultAgentWorkflowDeps, ...overrides };
}

export function resetAgentWorkflowDepsForTest(): void {
  agentWorkflowDeps = defaultAgentWorkflowDeps;
}

export async function agentWorkflow(config: AgentWorkflowConfig): Promise<void> {
  if (
    config.initialMessage === undefined &&
    (config.initialMessages === undefined || config.initialMessages.length === 0)
  ) {
    return;
  }

  await agentWorkflowDeps.runAgentTurn(config);
}
