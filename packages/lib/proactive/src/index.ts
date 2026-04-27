/**
 * @koi/proactive — proactive/autonomous tool surfaces.
 *
 * Phase 3a (issue #1195): sleep + cron-facing tools layered over the L0
 * SchedulerComponent. Channel/webhook/monitor surfaces ship in later phases.
 */

export { createProactiveTools } from "./create-proactive-tools.js";
export { createProactiveToolsProvider } from "./provider.js";
export type { ProactiveToolsConfig, ProactiveToolsProviderConfig } from "./types.js";
export { DEFAULT_MAX_SLEEP_MS, DEFAULT_WAKE_MESSAGE } from "./types.js";
