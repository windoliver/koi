/**
 * System signal types — operational/system events for the proactive intelligence layer.
 *
 * Parallel to UserSignal (user-model.ts) but for system-facing concerns:
 * governance thresholds, Nexus VFS mutations, ForgeDemand signals, scheduler
 * terminal events, agent lifecycle transitions, behavioral anomalies, and
 * context compaction lifecycle.
 *
 * Consumers: CompositionPlanner (@koi/proactive) — watches system signal sources
 * continuously and detects moments that warrant autonomous composition action.
 *
 * ## Contract maturity
 * **v2-only, no existing implementations.** This is a brand-new L0 contract
 * introduced in v2. There are no existing `SystemSignalSource` implementations
 * or `SystemSignal` consumers to migrate. All L2 adapters (governance source,
 * VFS source, agent-monitor source) will be built against this contract in
 * downstream PRs.
 *
 * L0 types only — zero logic, zero deps beyond @koi/core internal files.
 */

import type { AnomalySignal } from "./agent-anomaly.js";
import type { AgentId, ProcessState } from "./ecs.js";
import type { KoiError } from "./errors.js";
import type { ForgeDemandSignal } from "./forge-demand.js";
import type { TransitionReason } from "./lifecycle.js";
import type { TaskId } from "./scheduler.js";
import type { ZoneId } from "./zone.js";

// ---------------------------------------------------------------------------
// CompositionSchedulerEvent — narrowed subset of SchedulerEvent
// ---------------------------------------------------------------------------

/**
 * Narrowed subset of SchedulerEvent for the composition planner.
 * Covers all terminal task outcomes — completed, failed, dead-lettered, and
 * cancelled. Operational events (task:submitted, task:started, schedule:paused,
 * etc.) are excluded as they are not composition-relevant.
 *
 * `task:cancelled` is included because `TaskScheduler.cancel()` is a first-class
 * operation; excluding it would create a blind spot around aborted work,
 * compensation, and retry-suppression after partial execution.
 */
export type CompositionSchedulerEvent =
  | { readonly kind: "task:completed"; readonly taskId: TaskId; readonly result: unknown }
  | { readonly kind: "task:failed"; readonly taskId: TaskId; readonly error: KoiError }
  | { readonly kind: "task:dead_letter"; readonly taskId: TaskId; readonly error: KoiError }
  /**
   * Task was cancelled before execution began (queue cancellation only).
   * Does NOT indicate partial execution — the task never started.
   * Use for retry suppression on work that was explicitly aborted pre-start.
   */
  | { readonly kind: "task:cancelled"; readonly taskId: TaskId };

// ---------------------------------------------------------------------------
// SystemSignal — discriminated union of system-facing events
// ---------------------------------------------------------------------------

/**
 * Discriminated union of system-facing signals consumed by the composition planner.
 *
 * Each variant maps to a distinct signal source:
 * - "governance"      → GovernanceController (sensor threshold crossed)
 * - "vfs"             → Nexus VFS (file mutation)
 * - "forge_demand"    → ForgeDemand middleware (capability gap detected)
 * - "schedule"        → TaskScheduler (terminal task outcome)
 * - "agent_lifecycle" → AgentRegistry (agent state transition)
 * - "anomaly"         → AgentMonitor (behavioral/statistical anomaly detected)
 * - "compaction"      → Context compaction lifecycle (pre/post)
 *
 * ## Two-level discrimination for "forge_demand"
 * The "forge_demand" variant is ForgeDemandSignal inlined into the union.
 * Pattern matching requires two switch levels:
 *
 *   L1: switch (signal.kind) → "forge_demand" narrows to ForgeDemandSignal
 *   L2: switch (signal.trigger.kind) → specific ForgeTrigger variant
 *
 * This preserves full ForgeDemandSignal metadata (confidence, suggestedBrickKind,
 * context, emittedAt) without duplication.
 *
 * ## Two-level discrimination for "anomaly"
 * The "anomaly" variant wraps AnomalySignal (AnomalyBase & AnomalyDetail):
 *
 *   L1: switch (signal.kind) → "anomaly" narrows to anomaly wrapper
 *   L2: switch (signal.anomaly.kind) → specific AnomalyDetail variant
 */
export type SystemSignal =
  | {
      readonly kind: "governance";
      /** Name of the governance sensor that crossed its limit. */
      readonly sensor: string;
      /** Current reading at the time of signal emission. */
      readonly value: number;
      /** Configured limit for this sensor. */
      readonly limit: number;
      readonly direction: "above" | "below";
      /** Unix timestamp (ms) when the threshold was crossed. */
      readonly emittedAt: number;
    }
  | {
      readonly kind: "vfs";
      readonly event: "write" | "delete";
      readonly path: string;
      readonly zoneId?: ZoneId | undefined;
      /** Unix timestamp (ms) of the filesystem event. */
      readonly emittedAt: number;
    }
  | {
      readonly kind: "vfs";
      readonly event: "rename";
      /**
       * Source path before the rename. Aliased as `path` so handlers that
       * narrow only on `kind === "vfs"` and read `signal.path` work uniformly
       * across write, delete, and rename variants.
       */
      readonly path: string;
      /** Source path before the rename (same as `path`). */
      readonly from: string;
      /** Destination path after the rename. */
      readonly to: string;
      readonly zoneId?: ZoneId | undefined;
      /** Unix timestamp (ms) of the filesystem event. */
      readonly emittedAt: number;
    }
  /** Inlined ForgeDemandSignal — use signal.trigger for the specific ForgeTrigger variant. */
  | ForgeDemandSignal
  | {
      readonly kind: "schedule";
      readonly event: CompositionSchedulerEvent;
      /** Unix timestamp (ms) when the task reached terminal state. */
      readonly emittedAt: number;
    }
  | {
      readonly kind: "agent_lifecycle";
      readonly agentId: AgentId;
      readonly from: ProcessState;
      readonly to: ProcessState;
      /**
       * Why the transition occurred. Allows the composition planner to
       * distinguish normal completion from timeout, governance block,
       * budget exhaustion, error, etc. Sourced from the registry transition
       * event, which always carries a reason.
       */
      readonly reason: TransitionReason;
      /**
       * CAS generation counter from the registry entry at transition time.
       * Use to reject stale or out-of-order lifecycle events. Monotonically
       * increasing per agent; sourced from the registry, which always supplies it.
       */
      readonly generation: number;
      /** Unix timestamp (ms) of the state transition. */
      readonly emittedAt: number;
    }
  | {
      readonly kind: "anomaly";
      /**
       * Full anomaly signal: AnomalyBase context + AnomalyDetail.
       * Use signal.anomaly.kind to switch on the specific anomaly type.
       * @see AnomalyDetail in agent-anomaly.ts for all 12 variants.
       */
      readonly anomaly: AnomalySignal;
    }
  | {
      readonly kind: "compaction";
      readonly agentId: AgentId;
      /** "pre" = compaction is about to start; "post" = compaction completed. */
      readonly phase: "pre" | "post";
      /** Context window utilization at the time of this event (0–1). */
      readonly utilization: number;
      /** Unix timestamp (ms) of the compaction lifecycle event. */
      readonly emittedAt: number;
    };

// ---------------------------------------------------------------------------
// SystemSignalSourceOptions
// ---------------------------------------------------------------------------

/**
 * Options for SystemSignalSource.watch().
 *
 * All fields are optional and may be ignored by implementations that do not
 * support the corresponding feature.
 */
export interface SystemSignalSourceOptions {
  /**
   * Minimum interval between handler calls in milliseconds.
   * Sources SHOULD honor this to prevent flooding the composition planner
   * with high-frequency events (e.g., rapid VFS writes, governance ticks).
   * Default: no rate limiting.
   */
  readonly sampleRateMs?: number | undefined;
  /**
   * If true, the source SHOULD emit a synthetic current-state signal
   * immediately on subscribe before the first natural event arrives.
   * Enables the composition planner to bootstrap with current state
   * instead of waiting for the next event cycle.
   * Default: no replay.
   */
  readonly replay?: boolean | undefined;
  /**
   * Called when the source encounters an unrecoverable error.
   * The subscription remains active unless explicitly unsubscribed.
   */
  readonly onError?: ((err: unknown) => void) | undefined;
  /**
   * Called when the source disconnects or shuts down cleanly.
   * After this fires, no further handler calls will occur.
   */
  readonly onDisconnect?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// SystemSignalSource
// ---------------------------------------------------------------------------

/**
 * Push-based interface for system signal sources.
 *
 * ## Delivery contract
 * Sources MUST deliver handler calls asynchronously (e.g., via `queueMicrotask`
 * or `setTimeout(fn, 0)`) when signal emission crosses I/O or compute
 * boundaries. Synchronous delivery that blocks on a slow handler will stall
 * the source event loop.
 *
 * ## Lifecycle
 * The `watch()` call returns an unsubscribe function. Call it to stop
 * receiving signals and release any resources held by the subscription.
 *
 * ## Contrast with UserSignal / SignalSource
 * `SignalSource` (user-model.ts) is pull-based: `read()` samples sensors on
 * demand. `SystemSignalSource` is push-based: `watch()` subscribes to events
 * that fire asynchronously. User signals → context injection middleware.
 * System signals → CompositionPlanner (@koi/proactive).
 */
export interface SystemSignalSource {
  readonly name: string;
  /**
   * Subscribe to signals from this source.
   *
   * @param handler  Called for each emitted signal. Must not throw.
   * @param options  Optional delivery constraints and lifecycle callbacks.
   * @returns        Unsubscribe function — call to stop receiving signals.
   */
  readonly watch: (
    handler: (signal: SystemSignal) => void,
    options?: SystemSignalSourceOptions | undefined,
  ) => () => void;
}
