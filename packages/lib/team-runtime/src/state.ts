import type { TeamEvent } from "./events.js";
import type { TeamTaskSpec } from "./spec.js";
import {
  handleTaskAdded,
  handleTaskAssigned,
  handleTaskCompleted,
  handleTaskCrashDetected,
  handleTeamCreated,
  type ReducerState,
} from "./state-handlers.js";

export interface TeamRuntimeTask extends TeamTaskSpec {
  readonly status: "pending" | "in_progress" | "completed";
  readonly assignedAgentId?: string | undefined;
}

export interface TeamRuntimeBoard {
  readonly all: () => readonly TeamRuntimeTask[];
  readonly get: (taskId: string) => TeamRuntimeTask | undefined;
  readonly ready: () => readonly TeamRuntimeTask[];
}

export interface TeamRuntimeSnapshot {
  readonly teamRunId: string;
  readonly board: TeamRuntimeBoard;
  readonly outputs: ReadonlyMap<string, string>;
  readonly activeAssignments: ReadonlyMap<string, string>;
  readonly activeResources: ReadonlySet<string>;
  readonly hasUnknownActiveResources: boolean;
  readonly blockedTaskIds: readonly string[];
  readonly events: readonly TeamEvent[];
}

function createReadonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const snapshot = new Map(source);
  Object.defineProperties(snapshot, {
    set: { value: undefined, writable: false, configurable: false },
    delete: { value: undefined, writable: false, configurable: false },
    clear: { value: undefined, writable: false, configurable: false },
  });
  return snapshot as ReadonlyMap<K, V>;
}

export function cloneReadonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return createReadonlyMap(source);
}

function cloneTask(task: TeamRuntimeTask): TeamRuntimeTask {
  return {
    ...task,
    dependencies: [...task.dependencies],
    sharedResources: task.sharedResources ? [...task.sharedResources] : undefined,
  };
}

function findCyclicTaskIds(tasksById: ReadonlyMap<string, TeamRuntimeTask>): ReadonlySet<string> {
  const cyclic = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string, path: string[]): void => {
    if (visiting.has(taskId)) {
      const startIndex = path.indexOf(taskId);
      const members = startIndex >= 0 ? path.slice(startIndex) : path;
      for (const member of members) cyclic.add(member);
      cyclic.add(taskId);
      return;
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = tasksById.get(taskId);
    if (task !== undefined) {
      for (const dep of task.dependencies) {
        if (!tasksById.has(dep)) continue;
        visit(dep, [...path, taskId]);
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of tasksById.keys()) {
    visit(taskId, []);
  }
  return cyclic;
}

function computeBlockedTaskIds(tasksById: ReadonlyMap<string, TeamRuntimeTask>): readonly string[] {
  const cyclic = findCyclicTaskIds(tasksById);
  const blocked: string[] = [];
  for (const [taskId, task] of tasksById) {
    if (task.status !== "pending") continue;
    const hasUnknownDep = task.dependencies.some((dep) => !tasksById.has(dep));
    if (hasUnknownDep || cyclic.has(taskId)) blocked.push(taskId);
  }
  return blocked;
}

function createBoard(tasksById: ReadonlyMap<string, TeamRuntimeTask>): TeamRuntimeBoard {
  const orderedTasks = [...tasksById.values()].map(cloneTask);

  return {
    all: () => orderedTasks.map(cloneTask),
    get: (taskId) => {
      const task = tasksById.get(taskId);
      return task === undefined ? undefined : cloneTask(task);
    },
    ready: () =>
      orderedTasks
        .filter((task) => {
          if (task.status !== "pending") return false;
          return task.dependencies.every((dependencyId) => {
            const dep = tasksById.get(dependencyId);
            return dep !== undefined && dep.status === "completed";
          });
        })
        .map(cloneTask),
  };
}

function dispatchEvent(state: ReducerState, event: TeamEvent): void {
  switch (event.kind) {
    case "team.created":
      handleTeamCreated(state, event);
      return;
    case "task.added":
      handleTaskAdded(state, event);
      return;
    case "task.assigned":
      handleTaskAssigned(state, event);
      return;
    case "task.completed":
      handleTaskCompleted(state, event);
      return;
    case "task.crash_detected":
      handleTaskCrashDetected(state, event);
      return;
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled team event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function computeHasUnknownActiveResources(state: ReducerState): boolean {
  for (const taskId of state.activeAssignments.keys()) {
    const task = state.tasksById.get(taskId);
    if (task?.sharedResources === undefined) return true;
  }
  return false;
}

export function reduceTeamEvents(events: readonly TeamEvent[]): TeamRuntimeSnapshot {
  let teamRunId = "";
  const state: ReducerState = {
    tasksById: new Map(),
    activeAssignments: new Map(),
    outputs: new Map(),
    resourceOwners: new Map(),
    createdSpecName: undefined,
  };

  for (const event of events) {
    if (teamRunId === "") {
      teamRunId = event.teamRunId;
    } else if (teamRunId !== event.teamRunId) {
      throw new Error(
        `Cannot reduce mixed teamRunId event stream: expected ${teamRunId}, received ${event.teamRunId}`,
      );
    }
    dispatchEvent(state, event);
  }

  return {
    teamRunId,
    board: createBoard(state.tasksById),
    outputs: createReadonlyMap(state.outputs),
    activeAssignments: createReadonlyMap(state.activeAssignments),
    activeResources: new Set(state.resourceOwners.keys()) as ReadonlySet<string>,
    hasUnknownActiveResources: computeHasUnknownActiveResources(state),
    blockedTaskIds: computeBlockedTaskIds(state.tasksById),
    events: [...events],
  };
}
