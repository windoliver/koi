import type { TeamRuntimeSnapshot, TeamRuntimeTask } from "./state.js";

function topologicalTaskOrder(tasks: readonly TeamRuntimeTask[]): readonly string[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task] as const));
  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const task of tasks) {
    dependents.set(task.taskId, []);
    inDegree.set(task.taskId, 0);
  }

  for (const task of tasks) {
    let degree = 0;
    for (const dependencyId of task.dependencies) {
      if (!tasksById.has(dependencyId)) {
        continue;
      }
      degree += 1;
      const downstream = dependents.get(dependencyId);
      if (downstream !== undefined) {
        downstream.push(task.taskId);
      }
    }
    inDegree.set(task.taskId, degree);
  }

  const queue = tasks.filter((task) => inDegree.get(task.taskId) === 0).map((task) => task.taskId);
  const ordered: string[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const taskId = queue[index];
    if (taskId === undefined) {
      continue;
    }

    ordered.push(taskId);
    for (const dependentId of dependents.get(taskId) ?? []) {
      const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependentId);
      }
    }
  }

  return ordered;
}

export function planRunnableTasks(snapshot: TeamRuntimeSnapshot): readonly TeamRuntimeTask[] {
  const runnableById = new Map(snapshot.board.ready().map((task) => [task.taskId, task] as const));

  return topologicalTaskOrder(snapshot.board.all())
    .map((taskId) => runnableById.get(taskId))
    .filter((task): task is TeamRuntimeTask => task !== undefined);
}
