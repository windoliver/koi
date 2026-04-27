/**
 * Public configuration types for @koi/proactive.
 *
 * Tools accept a SchedulerComponent (the agent-facing subset of TaskScheduler)
 * which already pins agentId, so this package never sees an AgentId directly.
 */

import type { SchedulerComponent } from "@koi/core";

/** Default wake message dispatched when a caller does not supply one. */
export const DEFAULT_WAKE_MESSAGE: string = "Wake up — your scheduled timer fired.";

/** Default ceiling on the `sleep` tool's `duration_ms` input — 24 hours. */
export const DEFAULT_MAX_SLEEP_MS: number = 24 * 60 * 60 * 1000;

export interface ProactiveToolsConfig {
  /** Agent-facing scheduler. Typically the SCHEDULER component for the assembling agent. */
  readonly scheduler: SchedulerComponent;
  /** Default text dispatched on wake when the caller does not supply one. */
  readonly defaultWakeMessage?: string;
  /** Maximum sleep duration accepted by the `sleep` tool. Defaults to 24 h. */
  readonly maxSleepMs?: number;
  /** Optional clock for deterministic testing. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Provider config — `scheduler` is intentionally omitted because the provider
 * resolves the SCHEDULER component from each attaching agent at attach time
 * (per-agent isolation). Tests and direct callers that want to bypass attach
 * should use `createProactiveTools(config)` and pass a SchedulerComponent.
 */
export interface ProactiveToolsProviderConfig {
  /** Default text dispatched on wake when the caller does not supply one. */
  readonly defaultWakeMessage?: string;
  /** Maximum sleep duration accepted by the `sleep` tool. Defaults to 24 h. */
  readonly maxSleepMs?: number;
  /** Optional clock for deterministic testing. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Assembly priority. Defaults to COMPONENT_PRIORITY.BUNDLED. */
  readonly priority?: number;
}
