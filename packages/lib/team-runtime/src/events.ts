import type { VectorClock } from "./conflicts.js";

export interface TeamEventBase {
  readonly eventId: string;
  readonly teamRunId: string;
  readonly timestamp: number;
  readonly taskId?: string | undefined;
  readonly agentId?: string | undefined;
}

export interface TeamCreatedEvent extends TeamEventBase {
  readonly kind: "team.created";
  readonly payload: { readonly specName: string };
}

export interface TaskAddedEvent extends TeamEventBase {
  readonly kind: "task.added";
  readonly taskId: string;
  readonly payload: {
    readonly subject: string;
    readonly description: string;
    readonly dependencies: readonly string[];
    readonly targetAgentType?: string | undefined;
    readonly sharedResources?: readonly string[] | undefined;
  };
}

export interface TaskAssignedEvent extends TeamEventBase {
  readonly kind: "task.assigned";
  readonly taskId: string;
  readonly agentId: string;
  readonly payload: {
    readonly sharedResources?: readonly string[] | undefined;
  };
}

export interface TaskCompletedEvent extends TeamEventBase {
  readonly kind: "task.completed";
  readonly taskId: string;
  readonly agentId: string;
  readonly payload: {
    readonly output: string;
    readonly vectorClock?: VectorClock | undefined;
    readonly sharedResources?: readonly string[] | undefined;
  };
}

export interface TaskCrashDetectedEvent extends TeamEventBase {
  readonly kind: "task.crash_detected";
  readonly taskId: string;
  readonly agentId: string;
  readonly payload: Record<string, never>;
}

export type TeamEvent =
  | TeamCreatedEvent
  | TaskAddedEvent
  | TaskAssignedEvent
  | TaskCompletedEvent
  | TaskCrashDetectedEvent;
