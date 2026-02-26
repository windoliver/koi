/**
 * Domain types for @koi/code-mode — all L2-local, no L0 additions needed.
 */

import type { FileEdit } from "@koi/core";
import type { PlanState, StepKind } from "./constants.js";

// ─── Step ────────────────────────────────────────────────────────────────

/** A step to create a new file with full content. */
export interface CreateStep {
  readonly kind: "create";
  readonly path: string;
  readonly content: string;
  readonly description?: string;
}

/** A step to edit an existing file with search-and-replace hunks. */
export interface EditStep {
  readonly kind: "edit";
  readonly path: string;
  readonly edits: readonly FileEdit[];
  readonly description?: string;
}

/** A step to delete an existing file. */
export interface DeleteStep {
  readonly kind: "delete";
  readonly path: string;
  readonly description?: string;
}

/** Discriminated union of plan steps. */
export type CodePlanStep = CreateStep | EditStep | DeleteStep;

// ─── File content hash ──────────────────────────────────────────────────

export interface FileContentHash {
  readonly path: string;
  readonly hash: number;
}

// ─── Plan ────────────────────────────────────────────────────────────────

export interface CodePlan {
  readonly id: string;
  readonly steps: readonly CodePlanStep[];
  readonly state: PlanState;
  readonly createdAt: number;
  readonly hashes: readonly FileContentHash[];
  readonly warnings: readonly string[];
  readonly fileContents?: ReadonlyMap<string, string>;
}

// ─── Preview ─────────────────────────────────────────────────────────────

export interface FilePreview {
  readonly path: string;
  readonly kind: StepKind;
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

export interface PlanPreview {
  readonly planId: string;
  readonly summary: string;
  readonly files: readonly FilePreview[];
  readonly totalLinesTruncated: boolean;
  readonly warnings: readonly string[];
}

// ─── Validation ──────────────────────────────────────────────────────────

export type ValidationIssueKind =
  | "AMBIGUOUS_MATCH"
  | "NO_MATCH"
  | "OVERLAP"
  | "STALE"
  | "FILE_TOO_LARGE"
  | "FILE_SIZE_WARNING"
  | "FILE_EXISTS"
  | "FILE_NOT_FOUND";

export interface ValidationIssue {
  readonly kind: ValidationIssueKind;
  readonly path: string;
  readonly message: string;
  readonly stepIndex: number;
}

// ─── Apply result ────────────────────────────────────────────────────────

export interface StepResult {
  readonly stepIndex: number;
  readonly path: string;
  readonly success: boolean;
  readonly error?: string;
}

export interface ApplyResult {
  readonly planId: string;
  readonly success: boolean;
  readonly steps: readonly StepResult[];
  readonly rolledBack: boolean;
  readonly rollbackErrors: readonly string[];
}

// ─── Plan status ─────────────────────────────────────────────────────────

export interface PlanStatus {
  readonly planId: string | undefined;
  readonly state: PlanState | undefined;
  readonly stepCount: number;
}
