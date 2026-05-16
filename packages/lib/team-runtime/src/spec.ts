export interface TeamAgentSpec {
  readonly agentType: string;
  readonly maxParallel?: number | undefined;
  readonly planModeRequired?: boolean | undefined;
}

export interface TeamTaskSpec {
  readonly taskId: string;
  readonly subject: string;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly targetAgentType?: string | undefined;
  readonly sharedResources?: readonly string[] | undefined;
}

export interface TeamBudgetPolicy {
  readonly total: number;
  readonly reserve?: number | undefined;
  readonly defaultSlice?: number | undefined;
}

export interface WriteCoordinationPolicy {
  readonly mode: "isolated" | "shared" | "hybrid";
  readonly sharedResources?: readonly string[] | undefined;
}

export interface TeamSpec {
  readonly name: string;
  readonly agents: readonly TeamAgentSpec[];
  readonly budget: TeamBudgetPolicy;
  readonly workspacePolicy: WriteCoordinationPolicy;
}

export function validateTeamSpec(spec: TeamSpec): TeamSpec {
  if (spec.name.trim().length === 0) {
    throw new Error("Team spec name must not be empty");
  }
  if (spec.agents.length === 0) {
    throw new Error("Team spec must declare at least one agent");
  }
  if (spec.budget.total <= 0) {
    throw new Error("Team spec budget.total must be > 0");
  }

  return {
    ...spec,
    agents: spec.agents.map((agent) => ({ ...agent })),
    budget: { ...spec.budget },
    workspacePolicy: {
      ...spec.workspacePolicy,
      sharedResources: spec.workspacePolicy.sharedResources?.slice(),
    },
  };
}
