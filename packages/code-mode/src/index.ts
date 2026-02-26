/**
 * @koi/code-mode — Structured code generation toolset (Layer 2)
 *
 * Provides a two-phase propose/apply workflow for code plans. Agents
 * create reviewable plans with file edits, validate them against the
 * filesystem, and apply them atomically.
 *
 * Depends on @koi/core and @koi/hash only — never on L1 or peer L2.
 */

// provider
export type { CodeModeProviderConfig } from "./component-provider.js";
export { createCodeModeProvider } from "./component-provider.js";
export type { CodeModeOperation, PlanState, StepKind } from "./constants.js";
// constants
export {
  DEFAULT_PREFIX,
  FILE_SIZE_REJECT_BYTES,
  FILE_SIZE_WARN_BYTES,
  PLAN_STATES,
  PREVIEW_CONTEXT_LINES,
  PREVIEW_LINES_PER_FILE,
  PREVIEW_LINES_TOTAL,
  STEP_KINDS,
  TOOL_NAMES,
} from "./constants.js";
// plan store — for custom store implementations
export type { PlanStore } from "./plan-store.js";
export { createPlanStore } from "./plan-store.js";
// preview
export { generatePreview } from "./preview.js";
export { createPlanApplyTool } from "./tools/plan-apply.js";
// tool factories — for advanced usage (custom tool composition)
export { createPlanCreateTool } from "./tools/plan-create.js";
export { createPlanStatusTool } from "./tools/plan-status.js";
// types
export type {
  ApplyResult,
  CodePlan,
  CodePlanStep,
  CreateStep,
  DeleteStep,
  EditStep,
  FileContentHash,
  FilePreview,
  PlanPreview,
  PlanStatus,
  RenameStep,
  StepResult,
  ValidationIssue,
  ValidationIssueKind,
} from "./types.js";
// validation — for custom validation pipelines
export type { ValidationConfig } from "./validation.js";
export {
  computeHashes,
  DEFAULT_VALIDATION_CONFIG,
  validateStaleness,
  validateSteps,
} from "./validation.js";
