/**
 * Shared types for failure classification and statistical tracking.
 */

/**
 * Base type for any failure record that needs timestamp ordering.
 * Domain packages extend this with their own fields.
 */
export interface FailureRecordBase {
  readonly timestamp: number;
}

/**
 * Running statistics computed from a streaming data source.
 * Replaces agent-monitor's LatencyStats with a generic name.
 */
export interface RunningStats {
  readonly count: number;
  readonly mean: number;
  readonly stddev: number;
}
