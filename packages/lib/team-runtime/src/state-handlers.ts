import type {
  TaskAddedEvent,
  TaskAssignedEvent,
  TaskCompletedEvent,
  TaskCrashDetectedEvent,
  TeamCreatedEvent,
} from "./events.js";
import type { TeamRuntimeTask } from "./state.js";

export interface ReducerState {
  readonly tasksById: Map<string, TeamRuntimeTask>;
  readonly activeAssignments: Map<string, string>;
  readonly outputs: Map<string, string>;
  readonly resourceOwners: Map<string, string>;
  createdSpecName: string | undefined;
}

function sameResourceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  for (const resource of right) {
    if (!set.has(resource)) return false;
  }
  return true;
}

export function reconcileSharedResources(
  taskId: string,
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): readonly string[] | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return [...incoming];
  if (sameResourceSet(existing, incoming)) return existing;
  throw new Error(
    `Conflicting sharedResources for task ${taskId}: existing=[${existing.join(",")}] incoming=[${incoming.join(",")}]`,
  );
}

function claimResources(
  state: ReducerState,
  taskId: string,
  resources: readonly string[],
  errorPrefix: string,
): void {
  for (const resource of resources) {
    const owner = state.resourceOwners.get(resource);
    if (owner !== undefined && owner !== taskId) {
      throw new Error(`${errorPrefix} shared resource ${resource} already held by ${owner}`);
    }
  }
  for (const resource of resources) {
    state.resourceOwners.set(resource, taskId);
  }
}

function releaseResources(state: ReducerState, taskId: string): void {
  for (const [resource, owner] of state.resourceOwners) {
    if (owner === taskId) state.resourceOwners.delete(resource);
  }
}

export function handleTeamCreated(state: ReducerState, event: TeamCreatedEvent): void {
  if (state.createdSpecName === undefined) {
    state.createdSpecName = event.payload.specName;
    return;
  }
  if (state.createdSpecName !== event.payload.specName) {
    throw new Error(`Conflicting duplicate team.created event for teamRunId: ${event.teamRunId}`);
  }
}

export function handleTaskAdded(state: ReducerState, event: TaskAddedEvent): void {
  const existing = state.tasksById.get(event.taskId);
  if (existing !== undefined) {
    backfillDuplicateTaskAdded(state, existing, event);
    return;
  }
  state.tasksById.set(event.taskId, {
    taskId: event.taskId,
    subject: event.payload.subject,
    description: event.payload.description,
    dependencies: [...event.payload.dependencies],
    targetAgentType: event.payload.targetAgentType,
    sharedResources: event.payload.sharedResources ? [...event.payload.sharedResources] : undefined,
    status: "pending",
  });
}

function backfillDuplicateTaskAdded(
  state: ReducerState,
  existing: TeamRuntimeTask,
  event: TaskAddedEvent,
): void {
  const identityMatches =
    existing.subject === event.payload.subject &&
    existing.description === event.payload.description &&
    existing.targetAgentType === event.payload.targetAgentType &&
    existing.dependencies.length === event.payload.dependencies.length &&
    existing.dependencies.every((dep, index) => dep === event.payload.dependencies[index]);
  if (!identityMatches) {
    throw new Error(`Conflicting duplicate task.added event for taskId: ${event.taskId}`);
  }
  const reconciled = reconcileSharedResources(
    event.taskId,
    existing.sharedResources,
    event.payload.sharedResources,
  );
  if (reconciled === existing.sharedResources) return;
  if (reconciled && existing.status === "in_progress") {
    claimResources(
      state,
      event.taskId,
      reconciled,
      `Cannot backfill task ${event.taskId} via duplicate task.added:`,
    );
  }
  state.tasksById.set(event.taskId, {
    ...existing,
    dependencies: [...existing.dependencies],
    sharedResources: reconciled,
  });
}

export function handleTaskAssigned(state: ReducerState, event: TaskAssignedEvent): void {
  const task = state.tasksById.get(event.taskId);
  if (task === undefined) {
    throw new Error(`Cannot assign unknown task: ${event.taskId}`);
  }
  if (task.status === "completed") {
    if (task.assignedAgentId === event.agentId) return;
    throw new Error(`Cannot assign completed task: ${event.taskId}`);
  }
  if (task.status === "in_progress") {
    if (task.assignedAgentId === event.agentId) {
      backfillInProgressAssignment(state, task, event);
      return;
    }
    throw new Error(`Cannot reassign in-progress task to another agent: ${event.taskId}`);
  }
  promotePendingToInProgress(state, task, event);
}

function backfillInProgressAssignment(
  state: ReducerState,
  task: TeamRuntimeTask,
  event: TaskAssignedEvent,
): void {
  const merged = reconcileSharedResources(
    event.taskId,
    task.sharedResources,
    event.payload.sharedResources,
  );
  if (merged === task.sharedResources) return;
  if (merged) {
    claimResources(state, event.taskId, merged, `Cannot backfill task ${event.taskId}:`);
  }
  state.tasksById.set(event.taskId, {
    ...task,
    dependencies: [...task.dependencies],
    sharedResources: merged,
  });
}

function promotePendingToInProgress(
  state: ReducerState,
  task: TeamRuntimeTask,
  event: TaskAssignedEvent,
): void {
  const resolved = reconcileSharedResources(
    event.taskId,
    task.sharedResources,
    event.payload.sharedResources,
  );
  if (resolved) {
    claimResources(state, event.taskId, resolved, `Cannot assign task ${event.taskId}:`);
  }
  state.tasksById.set(event.taskId, {
    ...task,
    dependencies: [...task.dependencies],
    sharedResources: resolved,
    status: "in_progress",
    assignedAgentId: event.agentId,
  });
  state.activeAssignments.set(event.taskId, event.agentId);
}

export function handleTaskCompleted(state: ReducerState, event: TaskCompletedEvent): void {
  const task = state.tasksById.get(event.taskId);
  if (task === undefined) {
    throw new Error(`Cannot complete unknown task: ${event.taskId}`);
  }
  if (task.status === "completed") {
    backfillCompletedDuplicate(state, task, event);
    return;
  }
  if (task.status === "pending") {
    throw new Error(`Cannot complete pending task: ${event.taskId}`);
  }
  if (task.assignedAgentId !== event.agentId) {
    throw new Error(`Cannot complete task assigned to another agent: ${event.taskId}`);
  }
  finalizeCompletion(state, task, event);
}

function backfillCompletedDuplicate(
  state: ReducerState,
  task: TeamRuntimeTask,
  event: TaskCompletedEvent,
): void {
  const priorOutput = state.outputs.get(event.taskId);
  if (task.assignedAgentId !== event.agentId || priorOutput !== event.payload.output) {
    throw new Error(`Conflicting duplicate task.completed event for taskId: ${event.taskId}`);
  }
  const merged = reconcileSharedResources(
    event.taskId,
    task.sharedResources,
    event.payload.sharedResources,
  );
  if (merged === task.sharedResources) return;
  state.tasksById.set(event.taskId, {
    ...task,
    dependencies: [...task.dependencies],
    sharedResources: merged,
  });
}

function finalizeCompletion(
  state: ReducerState,
  task: TeamRuntimeTask,
  event: TaskCompletedEvent,
): void {
  const completedResources = reconcileSharedResources(
    event.taskId,
    task.sharedResources,
    event.payload.sharedResources,
  );
  if (completedResources && task.sharedResources === undefined) {
    for (const resource of completedResources) {
      const owner = state.resourceOwners.get(resource);
      if (owner !== undefined && owner !== event.taskId) {
        throw new Error(
          `Cannot complete task ${event.taskId}: shared resource ${resource} already held by ${owner}`,
        );
      }
    }
  }
  state.tasksById.set(event.taskId, {
    ...task,
    dependencies: [...task.dependencies],
    sharedResources: completedResources,
    status: "completed",
    assignedAgentId: event.agentId,
  });
  state.activeAssignments.delete(event.taskId);
  state.outputs.set(event.taskId, event.payload.output);
  releaseResources(state, event.taskId);
}

export function handleTaskCrashDetected(state: ReducerState, event: TaskCrashDetectedEvent): void {
  const task = state.tasksById.get(event.taskId);
  if (task === undefined) {
    throw new Error(`Cannot crash-detect unknown task: ${event.taskId}`);
  }
  if (task.status === "pending") return;
  if (task.status === "completed") {
    throw new Error(`Cannot crash-detect completed task: ${event.taskId}`);
  }
  if (task.assignedAgentId !== event.agentId) {
    throw new Error(`Cannot crash-detect task assigned to another agent: ${event.taskId}`);
  }
  state.tasksById.set(event.taskId, {
    ...task,
    dependencies: [...task.dependencies],
    status: "pending",
    assignedAgentId: undefined,
  });
  state.activeAssignments.delete(event.taskId);
  releaseResources(state, event.taskId);
}
