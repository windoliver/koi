/**
 * @koi/middleware-plan-persist — file-backed persistence for write_plan.
 */

export {
  type ClearJournalResult,
  createPlanPersistBackend,
  type LoadPlanResult,
  type PlanPersistBackend,
  type RestoreJournalResult,
  type SavePlanResult,
} from "./adapter.js";
export {
  DEFAULT_BASE_DIR,
  type PlanPersistConfig,
  type PlanPersistFs,
  validatePlanPersistConfig,
} from "./config.js";
export {
  generatePlanMarkdown,
  generateSlug,
  generateTimestamp,
  type PlanFileMetadata,
  parsePlanMarkdown,
  validateSlug,
} from "./format.js";
export {
  createPlanPersistMiddleware,
  type PlanPersistBundle,
  type PlanPersistMiddlewareConfig,
} from "./plan-persist-middleware.js";
export {
  createPlanLoadProvider,
  createPlanSaveProvider,
  PLAN_LOAD_DESCRIPTOR,
  PLAN_LOAD_TOOL_NAME,
  PLAN_SAVE_DESCRIPTOR,
  PLAN_SAVE_TOOL_NAME,
} from "./tool-providers.js";
export type { OnPlanUpdate, PlanItem, PlanStatus, PlanUpdateContextLike } from "./types.js";
