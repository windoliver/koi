/**
 * Public configuration types for @koi/proactive.
 *
 * Tools accept a SchedulerComponent (the agent-facing subset of TaskScheduler)
 * and an optional AgentId used for scheduler-backed reconciliation of cached
 * idempotency state.
 */

import type { AgentId, SchedulerComponent } from "@koi/core";

/** Default wake message dispatched when a caller does not supply one. */
export const DEFAULT_WAKE_MESSAGE: string = "Wake up — your scheduled timer fired.";

/** Default ceiling on the `sleep` tool's `duration_ms` input — 24 hours. */
export const DEFAULT_MAX_SLEEP_MS: number = 24 * 60 * 60 * 1000;

export interface ProactiveToolsConfig {
  /** Agent-facing scheduler. Typically the SCHEDULER component for the assembling agent. */
  readonly scheduler: SchedulerComponent;
  /**
   * AgentId for the agent these tools serve. When set, `sleep` reconciles
   * cached idempotency entries against `scheduler.query({ agentId })` before
   * dedupe/cap checks: tasks the scheduler no longer reports as live get
   * dropped from the cache (so retries register fresh, instead of either
   * deduping to a dead ID or being denied by a stale cap). The provider
   * always supplies this; standalone callers may omit it for unit-style use.
   */
  readonly agentId?: AgentId;
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
