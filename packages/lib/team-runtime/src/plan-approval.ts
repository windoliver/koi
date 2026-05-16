import type { PlanApprovalResponseMessage } from "./mailbox.js";
import type { TeamMember } from "./manager.js";

export interface InProcessTeammateTaskLike {
  readonly id: string;
  readonly type: "in_process_teammate";
  readonly identity: {
    readonly agentName: string;
  };
  readonly awaitingPlanApproval?: boolean | undefined;
}

export interface InProcessTeammateAppStateLike {
  readonly tasks: Readonly<Record<string, unknown>>;
}

export type SetAppState<TState extends InProcessTeammateAppStateLike> = (
  updater: (prev: TState) => TState,
) => void;

function isInProcessTeammateTask(value: unknown): value is InProcessTeammateTaskLike {
  if (value === null || typeof value !== "object") return false;
  if (!("id" in value) || !("type" in value) || !("identity" in value)) return false;
  if (value.type !== "in_process_teammate") return false;
  const identity = value.identity;
  return (
    typeof value.id === "string" &&
    identity !== null &&
    typeof identity === "object" &&
    "agentName" in identity &&
    typeof identity.agentName === "string"
  );
}

export function isPlanModeRequired(member: Pick<TeamMember, "role" | "planModeRequired">): boolean {
  return member.role === "teammate" && member.planModeRequired === true;
}

export function findInProcessTeammateTaskId(
  agentName: string,
  appState: InProcessTeammateAppStateLike,
): string | undefined {
  const task = Object.values(appState.tasks).find(
    (task) => isInProcessTeammateTask(task) && task.identity.agentName === agentName,
  );
  return isInProcessTeammateTask(task) ? task.id : undefined;
}

export function setAwaitingPlanApproval<TState extends InProcessTeammateAppStateLike>(
  taskId: string,
  setAppState: SetAppState<TState>,
  awaiting: boolean,
): void {
  setAppState((prev) => {
    const task = prev.tasks[taskId];
    if (!isInProcessTeammateTask(task)) return prev;
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...task, awaitingPlanApproval: awaiting },
      },
    };
  });
}

export function handlePlanApprovalResponse<TState extends InProcessTeammateAppStateLike>(
  taskId: string,
  _response: PlanApprovalResponseMessage,
  setAppState: SetAppState<TState>,
): void {
  setAwaitingPlanApproval(taskId, setAppState, false);
}
