import type { TeamEvent } from "./events.js";
import { cloneReadonlyMap, reduceTeamEvents, type TeamRuntimeSnapshot } from "./state.js";

function detachTeamRuntimeBoard(board: TeamRuntimeSnapshot["board"]): TeamRuntimeSnapshot["board"] {
  return {
    all: () => board.all(),
    get: (taskId) => board.get(taskId),
    ready: () => board.ready(),
  };
}

export function detachTeamRuntimeSnapshot(snapshot: TeamRuntimeSnapshot): TeamRuntimeSnapshot {
  return {
    teamRunId: snapshot.teamRunId,
    board: detachTeamRuntimeBoard(snapshot.board),
    outputs: cloneReadonlyMap(snapshot.outputs),
    activeAssignments: cloneReadonlyMap(snapshot.activeAssignments),
    events: [...snapshot.events],
  };
}

export function replayTeamRun(events: readonly TeamEvent[]): TeamRuntimeSnapshot {
  return detachTeamRuntimeSnapshot(reduceTeamEvents(events));
}
