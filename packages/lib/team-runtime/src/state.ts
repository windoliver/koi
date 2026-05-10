import type { TeamEvent } from "./events.js";
import type { TeamTaskSpec } from "./spec.js";

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
  };
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
          return task.dependencies.every(
            (dependencyId) => tasksById.get(dependencyId)?.status === "completed",
          );
        })
        .map(cloneTask),
  };
}

export function reduceTeamEvents(events: readonly TeamEvent[]): TeamRuntimeSnapshot {
  let teamRunId = "";
  let createdSpecName: string | undefined;
  const outputs = new Map<string, string>();
  const activeAssignments = new Map<string, string>();
  const tasksById = new Map<string, TeamRuntimeTask>();

  for (const event of events) {
    if (teamRunId === "") {
      teamRunId = event.teamRunId;
    } else if (teamRunId !== event.teamRunId) {
      throw new Error(
        `Cannot reduce mixed teamRunId event stream: expected ${teamRunId}, received ${event.teamRunId}`,
      );
    }

    switch (event.kind) {
      case "team.created":
        if (createdSpecName === undefined) {
          createdSpecName = event.payload.specName;
          break;
        }
        if (createdSpecName !== event.payload.specName) {
          throw new Error(
            `Conflicting duplicate team.created event for teamRunId: ${event.teamRunId}`,
          );
        }
        break;
      case "task.added": {
        const existingTask = tasksById.get(event.taskId);
        if (existingTask !== undefined) {
          const isExactReplay =
            existingTask.subject === event.payload.subject &&
            existingTask.description === event.payload.description &&
            existingTask.targetAgentType === event.payload.targetAgentType &&
            existingTask.dependencies.length === event.payload.dependencies.length &&
            existingTask.dependencies.every(
              (dependency, index) => dependency === event.payload.dependencies[index],
            );
          if (!isExactReplay) {
            throw new Error(`Conflicting duplicate task.added event for taskId: ${event.taskId}`);
          }
          break;
        }
        tasksById.set(event.taskId, {
          taskId: event.taskId,
          subject: event.payload.subject,
          description: event.payload.description,
          dependencies: [...event.payload.dependencies],
          targetAgentType: event.payload.targetAgentType,
          status: "pending",
        });
        break;
      }
      case "task.assigned": {
        const task = tasksById.get(event.taskId);
        if (task === undefined) {
          throw new Error(`Cannot assign unknown task: ${event.taskId}`);
        }
        if (task.status === "completed") {
          if (task.assignedAgentId === event.agentId) {
            break;
          }
          throw new Error(`Cannot assign completed task: ${event.taskId}`);
        }
        if (task.status === "in_progress") {
          if (task.assignedAgentId === event.agentId) {
            break;
          }
          throw new Error(`Cannot reassign in-progress task to another agent: ${event.taskId}`);
        }
        tasksById.set(event.taskId, {
          ...task,
          dependencies: [...task.dependencies],
          status: "in_progress",
          assignedAgentId: event.agentId,
        });
        activeAssignments.set(event.taskId, event.agentId);
        break;
      }
      case "task.completed": {
        const task = tasksById.get(event.taskId);
        if (task === undefined) {
          throw new Error(`Cannot complete unknown task: ${event.taskId}`);
        }
        if (task.status === "completed") {
          const priorOutput = outputs.get(event.taskId);
          if (task.assignedAgentId === event.agentId && priorOutput === event.payload.output) {
            break;
          }
          throw new Error(`Conflicting duplicate task.completed event for taskId: ${event.taskId}`);
        }
        if (task.status === "pending") {
          throw new Error(`Cannot complete pending task: ${event.taskId}`);
        }
        if (task.assignedAgentId !== event.agentId) {
          throw new Error(`Cannot complete task assigned to another agent: ${event.taskId}`);
        }
        tasksById.set(event.taskId, {
          ...task,
          dependencies: [...task.dependencies],
          status: "completed",
          assignedAgentId: event.agentId,
        });
        activeAssignments.delete(event.taskId);
        outputs.set(event.taskId, event.payload.output);
        break;
      }
      case "task.crash_detected": {
        const task = tasksById.get(event.taskId);
        if (task === undefined) {
          throw new Error(`Cannot crash-detect unknown task: ${event.taskId}`);
        }
        if (task.status === "pending") {
          break;
        }
        if (task.status === "completed") {
          throw new Error(`Cannot crash-detect completed task: ${event.taskId}`);
        }
        if (task.assignedAgentId !== event.agentId) {
          throw new Error(`Cannot crash-detect task assigned to another agent: ${event.taskId}`);
        }
        tasksById.set(event.taskId, {
          ...task,
          dependencies: [...task.dependencies],
          status: "pending",
          assignedAgentId: undefined,
        });
        activeAssignments.delete(event.taskId);
        break;
      }
      default: {
        const _exhaustive: never = event;
        throw new Error(`Unhandled team event: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    teamRunId,
    board: createBoard(tasksById),
    outputs: createReadonlyMap(outputs),
    activeAssignments: createReadonlyMap(activeAssignments),
    events: [...events],
  };
}
