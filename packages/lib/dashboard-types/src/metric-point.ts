/**
 * One timestamped numeric sample, the unit of every dashboard chart.
 *
 * `tags` is the high-cardinality dimension set; aggregation is the API's
 * job, not the client's.
 */
export interface MetricPoint {
  readonly name: string;
  readonly value: number;
  readonly timestampMs: number;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/** Server-side metric query — both bounds inclusive, names AND'd with tags. */
export interface MetricQuery {
  readonly names: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly tags?: Readonly<Record<string, string>> | undefined;
  readonly limit?: number | undefined;
}
