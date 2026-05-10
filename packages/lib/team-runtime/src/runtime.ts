import type { TeamEvent } from "./events.js";
import { detachTeamRuntimeSnapshot, replayTeamRun } from "./replay.js";
import type { TeamSpec, TeamTaskSpec } from "./spec.js";
import { validateTeamSpec } from "./spec.js";
import type { TeamRuntimeSnapshot } from "./state.js";

export type TeamRunStatus = "snapshot_ready";

export interface TeamGoalInput {
  readonly goal: string;
  readonly tasks?: readonly TeamTaskSpec[] | undefined;
}

export interface TeamResumeInput {
  readonly events: readonly TeamEvent[];
}

export interface TeamRunHandle {
  readonly teamRunId: string;
  readonly getStatus: () => TeamRunStatus;
  readonly getSnapshot: () => TeamRuntimeSnapshot;
  readonly getResult: () => Promise<TeamRuntimeSnapshot>;
}

export interface TeamRuntimeDependencies {
  readonly scheduler?: unknown;
}

export interface TeamRuntime {
  readonly start: (goal: TeamGoalInput) => Promise<TeamRunHandle>;
  readonly resume: (input: TeamResumeInput) => Promise<TeamRunHandle>;
  readonly replay: (events: readonly TeamEvent[]) => TeamRuntimeSnapshot;
  readonly getSnapshot: () => TeamRuntimeSnapshot;
}

function createRunHandle(snapshot: TeamRuntimeSnapshot): TeamRunHandle {
  return {
    teamRunId: snapshot.teamRunId,
    getStatus: () => "snapshot_ready",
    getSnapshot: () => detachTeamRuntimeSnapshot(snapshot),
    getResult: async () => detachTeamRuntimeSnapshot(snapshot),
  };
}

export function createTeamRuntime(
  spec: TeamSpec,
  _deps: TeamRuntimeDependencies = {},
): TeamRuntime {
  const validatedSpec = validateTeamSpec(spec);
  let snapshot = replayTeamRun([]);
  let startCount = 0;

  return {
    async start(_goal) {
      startCount += 1;
      const teamRunId = `${validatedSpec.name}:run:${startCount}`;
      snapshot = replayTeamRun([
        {
          kind: "team.created",
          eventId: `team.created:${teamRunId}`,
          teamRunId,
          timestamp: 0,
          payload: { specName: validatedSpec.name },
        },
      ]);
      return createRunHandle(snapshot);
    },
    async resume(input) {
      snapshot = replayTeamRun(input.events);
      return createRunHandle(snapshot);
    },
    replay(events) {
      snapshot = replayTeamRun(events);
      return detachTeamRuntimeSnapshot(snapshot);
    },
    getSnapshot() {
      return detachTeamRuntimeSnapshot(snapshot);
    },
  };
}
