/**
 * Constants for @koi/code-mode — tool names, limits, and plan states.
 */

/** Default tool name prefix for code-mode tools. */
export const DEFAULT_PREFIX = "code_plan" as const;

/** All code-mode tool operations. */
export const TOOL_NAMES = ["create", "apply", "status"] as const;

export type CodeModeOperation = (typeof TOOL_NAMES)[number];

/** Plan state discriminant values. */
export const PLAN_STATES = ["pending", "applied", "failed"] as const;

export type PlanState = (typeof PLAN_STATES)[number];

/** Step kind discriminant values. */
export const STEP_KINDS = ["create", "edit", "delete", "rename"] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/** Soft file size warning threshold in bytes (512 KB). */
export const FILE_SIZE_WARN_BYTES: number = 512 * 1024;

/** Hard file size reject threshold in bytes (5 MB). */
export const FILE_SIZE_REJECT_BYTES: number = 5 * 1024 * 1024;

/** Maximum lines per file in preview output. */
export const PREVIEW_LINES_PER_FILE = 50;

/** Maximum total lines in preview output. */
export const PREVIEW_LINES_TOTAL = 200;

/** Number of context lines to show around each edit in preview. */
export const PREVIEW_CONTEXT_LINES = 3;
