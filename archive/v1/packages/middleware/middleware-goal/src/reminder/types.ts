/**
 * Types for @koi/middleware-goal-reminder.
 */

import type { TurnContext } from "@koi/core/middleware";

/**
 * Discriminated union for reminder content sources.
 *
 * - manifest: objectives from the agent manifest
 * - static: fixed text (e.g. constraints, style guidelines)
 * - dynamic: lazily-fetched text (e.g. from a config store or derived from conversation)
 * - tasks: active task list (e.g. from a todo tracker)
 *
 * `dynamic.fetch` and `tasks.provider` receive the current `TurnContext`,
 * allowing goals to be derived from the live conversation state.
 */
export type ReminderSource =
  | { readonly kind: "manifest"; readonly objectives: readonly string[] }
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "dynamic"; readonly fetch: (ctx: TurnContext) => string | Promise<string> }
  | {
      readonly kind: "tasks";
      readonly provider: (ctx: TurnContext) => readonly string[] | Promise<readonly string[]>;
    };

export interface ReminderSessionState {
  readonly turnCount: number;
  readonly currentInterval: number;
  readonly lastReminderTurn: number;
  readonly shouldInject: boolean;
}
