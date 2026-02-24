/**
 * Configuration types for the context-editing middleware.
 */

import type { TokenEstimator } from "@koi/core/context";

export interface ContextEditingConfig {
  /** Token count that triggers clearing. Default: 100_000. */
  readonly triggerTokenCount?: number;
  /** Number of most recent tool results to preserve. Default: 3. */
  readonly numRecentToKeep?: number;
  /** Also clear tool call inputs in corresponding assistant messages. Default: true. */
  readonly clearToolCallInputs?: boolean;
  /** Tool names whose results should never be cleared. Default: []. */
  readonly excludeTools?: readonly string[];
  /** Replacement text for cleared content. Default: "[cleared]". */
  readonly placeholder?: string;
  /** Token estimator. Default: heuristic (4 chars/token). */
  readonly tokenEstimator?: TokenEstimator;
}

export interface ResolvedContextEditingConfig {
  readonly triggerTokenCount: number;
  readonly numRecentToKeep: number;
  readonly clearToolCallInputs: boolean;
  readonly excludeTools: ReadonlySet<string>;
  readonly placeholder: string;
  readonly tokenEstimator: TokenEstimator;
}

interface ContextEditingDefaults {
  readonly triggerTokenCount: number;
  readonly numRecentToKeep: number;
  readonly clearToolCallInputs: boolean;
  readonly placeholder: string;
}

export const CONTEXT_EDITING_DEFAULTS: ContextEditingDefaults = Object.freeze({
  triggerTokenCount: 100_000,
  numRecentToKeep: 3,
  clearToolCallInputs: true,
  placeholder: "[cleared]",
});
