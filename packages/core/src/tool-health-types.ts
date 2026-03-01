/**
 * Tool health types — promoted to L0 for cross-package consumption.
 *
 * These types were originally defined in @koi/middleware-feedback-loop.
 * Promoted to L0 so L2 packages (e.g., @koi/forge-demand) can consume
 * health data without L2→L2 imports.
 */

/** Aggregated health metrics for a single tool. */
export interface ToolHealthMetrics {
  /** Success rate (0-1). */
  readonly successRate: number;
  /** Error rate (0-1). */
  readonly errorRate: number;
  /** Total invocations in the tracking window. */
  readonly usageCount: number;
  /** Average latency in milliseconds. */
  readonly avgLatencyMs: number;
}

/** Health state of a forged tool. */
export type ToolHealthState = "healthy" | "degraded" | "quarantined";

/** Point-in-time snapshot of a tool's health. */
export interface ToolHealthSnapshot {
  readonly brickId: string;
  readonly toolId: string;
  readonly metrics: ToolHealthMetrics;
  readonly state: ToolHealthState;
  readonly recentFailures: readonly ToolFailureRecord[];
  readonly lastUpdatedAt: number;
}

/** Record of a single tool failure. */
export interface ToolFailureRecord {
  readonly timestamp: number;
  readonly error: string;
  readonly latencyMs: number;
}
