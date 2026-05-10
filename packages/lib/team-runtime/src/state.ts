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

function sameResourceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  for (const resource of right) {
    if (!set.has(resource)) return false;
  }
  return true;
}

function reconcileSharedResources(
  taskId: string,
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): readonly string[] | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return [...incoming];
  if (sameResourceSet(existing, incoming)) {
    return existing;
  }
  throw new Error(
    `Conflicting sharedResources for task ${taskId}: existing=[${existing.join(",")}] incoming=[${incoming.join(",")}]`,
  );
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

export function reduceTeamEvents(events: readonly TeamEvent[]): TeamRuntimeSnapshot {
  let teamRunId = "";
  let createdSpecName: string | undefined;
  const outputs = new Map<string, string>();
  const activeAssignments = new Map<string, string>();
  const tasksById = new Map<string, TeamRuntimeTask>();
  const resourceOwners = new Map<string, string>();

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
          const identityMatches =
            existingTask.subject === event.payload.subject &&
            existingTask.description === event.payload.description &&
            existingTask.targetAgentType === event.payload.targetAgentType &&
            existingTask.dependencies.length === event.payload.dependencies.length &&
            existingTask.dependencies.every(
              (dependency, index) => dependency === event.payload.dependencies[index],
            );
          if (!identityMatches) {
            throw new Error(`Conflicting duplicate task.added event for taskId: ${event.taskId}`);
          }
          const reconciled = reconcileSharedResources(
            event.taskId,
            existingTask.sharedResources,
            event.payload.sharedResources,
          );
          if (reconciled !== existingTask.sharedResources) {
            if (reconciled && existingTask.status === "in_progress") {
              for (const resource of reconciled) {
                const owner = resourceOwners.get(resource);
                if (owner !== undefined && owner !== event.taskId) {
                  throw new Error(
                    `Cannot backfill task ${event.taskId} via duplicate task.added: shared resource ${resource} already held by ${owner}`,
                  );
                }
              }
              for (const resource of reconciled) {
                resourceOwners.set(resource, event.taskId);
              }
            }
            tasksById.set(event.taskId, {
              ...existingTask,
              dependencies: [...existingTask.dependencies],
              sharedResources: reconciled,
            });
          }
          break;
        }
        tasksById.set(event.taskId, {
          taskId: event.taskId,
          subject: event.payload.subject,
          description: event.payload.description,
          dependencies: [...event.payload.dependencies],
          targetAgentType: event.payload.targetAgentType,
          sharedResources: event.payload.sharedResources
            ? [...event.payload.sharedResources]
            : undefined,
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
            const merged = reconcileSharedResources(
              event.taskId,
              task.sharedResources,
              event.payload.sharedResources,
            );
            if (merged !== task.sharedResources) {
              if (merged) {
                for (const resource of merged) {
                  const owner = resourceOwners.get(resource);
                  if (owner !== undefined && owner !== event.taskId) {
                    throw new Error(
                      `Cannot backfill task ${event.taskId}: shared resource ${resource} already held by ${owner}`,
                    );
                  }
                }
                for (const resource of merged) {
                  resourceOwners.set(resource, event.taskId);
                }
              }
              tasksById.set(event.taskId, {
                ...task,
                dependencies: [...task.dependencies],
                sharedResources: merged,
              });
            }
            break;
          }
          throw new Error(`Cannot reassign in-progress task to another agent: ${event.taskId}`);
        }
        const resolvedResources = reconcileSharedResources(
          event.taskId,
          task.sharedResources,
          event.payload.sharedResources,
        );
        if (resolvedResources) {
          for (const resource of resolvedResources) {
            const owner = resourceOwners.get(resource);
            if (owner !== undefined && owner !== event.taskId) {
              throw new Error(
                `Cannot assign task ${event.taskId}: shared resource ${resource} already held by ${owner}`,
              );
            }
          }
          for (const resource of resolvedResources) {
            resourceOwners.set(resource, event.taskId);
          }
        }
        tasksById.set(event.taskId, {
          ...task,
          dependencies: [...task.dependencies],
          sharedResources: resolvedResources,
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
            const merged = reconcileSharedResources(
              event.taskId,
              task.sharedResources,
              event.payload.sharedResources,
            );
            if (merged !== task.sharedResources) {
              tasksById.set(event.taskId, {
                ...task,
                dependencies: [...task.dependencies],
                sharedResources: merged,
              });
            }
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
        const completedResources = reconcileSharedResources(
          event.taskId,
          task.sharedResources,
          event.payload.sharedResources,
        );
        if (completedResources && task.sharedResources === undefined) {
          for (const resource of completedResources) {
            const owner = resourceOwners.get(resource);
            if (owner !== undefined && owner !== event.taskId) {
              throw new Error(
                `Cannot complete task ${event.taskId}: shared resource ${resource} already held by ${owner}`,
              );
            }
          }
        }
        tasksById.set(event.taskId, {
          ...task,
          dependencies: [...task.dependencies],
          sharedResources: completedResources,
          status: "completed",
          assignedAgentId: event.agentId,
        });
        activeAssignments.delete(event.taskId);
        outputs.set(event.taskId, event.payload.output);
        for (const [resource, owner] of resourceOwners) {
          if (owner === event.taskId) resourceOwners.delete(resource);
        }
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
        for (const [resource, owner] of resourceOwners) {
          if (owner === event.taskId) resourceOwners.delete(resource);
        }
        break;
      }
      default: {
        const _exhaustive: never = event;
        throw new Error(`Unhandled team event: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  const activeResources = new Set<string>(resourceOwners.keys());
  let hasUnknownActiveResources = false;
  for (const taskId of activeAssignments.keys()) {
    const task = tasksById.get(taskId);
    if (task?.sharedResources === undefined) {
      hasUnknownActiveResources = true;
      break;
    }
  }

  return {
    teamRunId,
    board: createBoard(tasksById),
    outputs: createReadonlyMap(outputs),
    activeAssignments: createReadonlyMap(activeAssignments),
    activeResources: new Set(activeResources) as ReadonlySet<string>,
    hasUnknownActiveResources,
    blockedTaskIds: computeBlockedTaskIds(tasksById),
    events: [...events],
  };
}
