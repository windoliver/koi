import { planRunnableTasks } from "./planner.js";
import type { TeamRuntimeSnapshot, TeamRuntimeTask } from "./state.js";

export interface TeamScheduler {
  readonly dispatch: (
    snapshot: TeamRuntimeSnapshot,
    availableAgents: readonly string[],
  ) => Promise<void>;
}

export interface TeamSchedulerConfig {
  readonly assign: (task: TeamRuntimeTask, agentId: string) => Promise<void>;
}

export function createTeamScheduler(config: TeamSchedulerConfig): TeamScheduler {
  return {
    async dispatch(snapshot, availableAgents) {
      const runnable = planRunnableTasks(snapshot);
      const tasks = runnable.slice(0, availableAgents.length);
      const assignments = tasks.map((task, index) => ({
        task,
        agentId: availableAgents[index] ?? "unassigned",
      }));
      await Promise.all(assignments.map(({ task, agentId }) => config.assign(task, agentId)));
    },
  };
}
