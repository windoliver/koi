import type { AgentStateRefs, AgentWorkflowConfig } from "../types.js";

export interface AgentActivityDeps {
  readonly runTurn: (
    input: AgentWorkflowConfig,
  ) => Promise<{
    readonly turnId: string;
    readonly updatedStateRefs: AgentStateRefs;
    readonly next: { readonly kind: "complete" | "retry" };
  }>;
}

export function createAgentActivities(deps: AgentActivityDeps) {
  return {
    async runAgentTurn(input: AgentWorkflowConfig) {
      return deps.runTurn(input);
    },
  };
}
