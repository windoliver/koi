/**
 * @koi/proactive — proactive/autonomous tool surfaces.
 *
 * Phase 3a (issue #1195): sleep + cron-facing tools layered over the L0
 * SchedulerComponent. Channel/webhook/monitor surfaces ship in later phases.
 */

export {
  computeCompositionApproval,
  DEFAULT_COMPOSITION_APPROVAL_POLICY,
} from "./composition-approval.js";
export {
  type CompositionExecutionContext,
  type CompositionForgeRequest,
  type CompositionNotification,
  type CompositionSpawnRequest,
  createCompositionExecutor,
} from "./composition-executor.js";
export { mapSystemSignalToCompositionTrigger } from "./composition-trigger.js";
export { createProactiveTools } from "./create-proactive-tools.js";
export {
  type CompositionPlannerAdapter,
  type CompositionPlannerAdapterInput,
  createLlmCompositionPlanner,
  type LlmCompositionPlannerConfig,
} from "./llm-composition-planner.js";
export { createProactiveToolsProvider } from "./provider.js";
export {
  createRuleBasedCompositionPlanner,
  type RuleBasedCompositionPlannerConfig,
} from "./rule-based-composition-planner.js";
export type { ProactiveToolsConfig, ProactiveToolsProviderConfig } from "./types.js";
export { DEFAULT_MAX_SLEEP_MS, DEFAULT_WAKE_MESSAGE } from "./types.js";
