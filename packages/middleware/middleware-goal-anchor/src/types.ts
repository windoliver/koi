/**
 * Types for @koi/middleware-goal-anchor todo state.
 */

export type TodoItemStatus = "pending" | "completed";

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: TodoItemStatus;
}

export interface TodoState {
  readonly items: readonly TodoItem[];
}
